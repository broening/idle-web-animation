# OBS addon

Optional. The core (`player/`, `studio/`, `tools/`) builds and runs a figure
without any of this - `figure.html` is a thin page that puts a figure into an
OBS Studio Browser Source, with its mood able to follow the name of the scene
that is showing it.

## Set it up in OBS

1. Start the repo's own server from the project root:

   ```
   python tools/serve.py
   ```

   It serves the whole repository on `127.0.0.1:5173` and binds only to
   localhost - the same server the studio uses, so if you already have it
   running for that, this addon uses it too.

2. In OBS, add a **Browser Source** and set its URL to:

   ```
   http://127.0.0.1:5173/addons/obs/figure.html?figure=pedro
   ```

   Replace `pedro` with the name of any folder under `figures/` (letters,
   digits, `.`, `_`, `-` only - anything else is ignored and the page falls
   back to `pedro`).

3. Set the source's **Width** and **Height** to whatever the scene needs. The
   page always fits the figure's own canvas into whatever box it is given,
   the same way the player does everywhere else (`fit()`), so there is
   nothing else to configure for sizing.

4. Transparency needs no setup: the page paints nothing but the figure, on a
   transparent background, by default. If a particular capture chain in your
   setup flattens alpha away, `?bg=00ff00` (3 or 6 hex digits, no `#`) gives
   the page a solid background you can chroma-key instead - append it to the
   URL, e.g. `...figure.html?figure=pedro&bg=00ff00`.

## Scene naming (moods)

The page can read the name of the currently active OBS scene and switch the
figure's mood to match, with no coding: name a scene so one of its words is a
mood, and the figure follows it as you switch scenes live.

- A scene called **"Pause sad"** switches to the `sad` mood, because `sad` is
  one of its words. Matching is case-insensitive and looks at the *first*
  matching word in the scene name, so `"Just Chatting happy"` and `"happy
  chatting"` both land on `happy`. A word has to match a mood name exactly -
  `sad-ish` is one hyphenated word, not `sad` plus something, and does not
  match.
- A scene name with **no mood word at all** falls back to `?state=` (see
  below), or to `neutral` if `?state=` was not given either.
- `?state=<name>` sets the mood the page starts in *and* the fallback used
  whenever a scene name carries no mood of its own, e.g.
  `...figure.html?figure=pedro&state=sad`.

Moods need `figure.states` on the figure and `IdleFigure#setState` in the
player - both arrive with the moods feature (tracked separately). Until a
figure actually has states, the page runs, but every mood switch is a no-op
and the figure simply stays in its neutral pose. Nothing breaks in the
meantime; there is just nothing to switch to yet.

### The page permission scene names need

Reading the active scene name uses the `window.obsstudio` API the
**obs-browser** plugin (bundled with OBS Studio) injects into every Browser
Source: `obsstudio.getCurrentScene(callback)` once, and the `obsSceneChanged`
event after that (`event.detail.name`). obs-browser's documentation
(<https://github.com/obsproject/obs-browser>) lists `getCurrentScene` as
needing the permission level READ_USER; it lists no level for the event.
Without READ_USER the page therefore does not learn which scene is live when
it loads, only which one comes next. Open the Browser Source's
**Properties**, find **Page permissions**, and pick the level that reads user
information (the scene collection and transitions) or anything above it.

Below that permission level, or outside OBS entirely (a plain browser tab,
for previewing), `window.obsstudio` is either absent or simply never calls
back. `scene.js` guards every one of these calls, so the page never throws
either way - it just never learns the scene name, and every figure shown
through it stays on its `?state=` mood (or neutral).

## Avatar with camera

`avatar.html` is `figure.html` plus a webcam: the figure looks where you
look, blinks when you blink, opens its mouth when you talk, and can switch to
a `happy` mood when you smile - all read from your face with [MediaPipe Face
Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker),
loaded from a CDN at a pinned version. `figure.html` never does any of this
and needs none of what follows; use it instead for a figure that only
follows the scene name.

**This has been built without a camera or a copy of OBS 31+ to test it on.**
The rules below (hysteresis thresholds, the face-lost fallback, the smile
timer) are proven in Node against synthetic data - `node
tools/test-addons.mjs` - and the page has been opened in a browser with no
camera at all, where it fell back to the idle figure exactly as designed.
Whether the head-turn direction and the blink/mouth thresholds feel right on
an actual face is genuinely unverified; expect to spend a few minutes with
`?debug=1` the first time.

### Requirements

- **OBS Studio 31 or newer.** OBS 28 to 30 embed Chromium 103, and nobody
  has confirmed that MediaPipe runs there; OBS 31 and later embed Chromium
  127. `figure.html` alone works on OBS 28 and later.
- OBS has to be started with camera access allowed in its embedded browser:
  add **`--enable-media-stream`** to how OBS is launched. On Windows,
  right-click the OBS shortcut, **Properties**, and append it to the end of
  the **Target** field, after the closing quote of the path to `obs64.exe`,
  with a space before it - for example:

  ```
  "C:\Program Files\obs-studio\bin\64bit\obs64.exe" --enable-media-stream
  ```

  Launch OBS from that shortcut (or the equivalent added to a taskbar
  shortcut's own Properties) rather than from the Start menu entry, which
  does not carry the flag.
- The page has to be loaded from `http://127.0.0.1:5173/...` via `python
  tools/serve.py` - **not** a `file://` path. `getUserMedia` refuses to run
  at all outside a secure context, and `file://` is not one; `127.0.0.1` and
  `localhost` are the browser's standing exception, same as the studio
  already relies on.
- If OBS itself also shows the camera (a Video Capture Device source) while
  this page reads it, two programs want the same camera at once, and Windows
  traditionally gives a camera to one program only. Windows 11 24H2 and later
  can share it: **Settings > Bluetooth & devices > Cameras > (your camera) >
  Allow multiple apps to use camera at the same time**. Without that, the
  second one gets a black frame or an error.

### Set it up in OBS

Add a **Browser Source** exactly as in the section above, pointed at
`avatar.html` instead of `figure.html`:

```
http://127.0.0.1:5173/addons/obs/avatar.html?figure=pedro
```

OBS's embedded browser has no permission prompt to click. If the camera
stays off with `--enable-media-stream` alone (`?debug=1` then says so),
add `--use-fake-ui-for-media-stream` to the shortcut as well; it answers the
prompt with yes on its own. Everything under "Scene naming (moods)" above still applies
unchanged: the scene name sets the figure's base mood, `?state=` sets the
starting mood and the fallback for a scene with no mood word of its own.

### What the camera controls

- **Head turn and gaze** follow your head's yaw and pitch, the same
  `pointerX`/`pointerY` the mouse drives on the demo page -
  25 degrees of head turn is "full deflection". If the figure turns the
  wrong way (away from the side you actually turned toward, as seen in your
  own camera preview), append `&mirror=0` to the URL to flip it. Pitch
  (nodding) is never mirrored - there is no left/right to get backwards
  there.
- **Blinking** replaces the figure's own blink schedule for as long as a
  face is tracked: both eyes have to register as closed at once for the lids
  to drop, so a wink alone will not do it. Losing the face for more than a
  second (camera covered, you step out of frame) hands the schedule back and
  the figure blinks on its own again, the same as `figure.html` always does.
- **An open mouth** while you are talking needs the figure to have it to
  show: two full-canvas layers on the head, `"role": "mouthOpen"` and
  `"role": "mouthClosed"` (see the mouth recipe in `../../AGENTS.md`).
  Without those two layers this does nothing - the figure has no mouth to
  open or close, silently, which is the same "nothing breaks, there is just
  nothing to switch to" story `figure.html` already tells for moods on a
  figure that has none.
- **A held smile** (about half a second) switches the mood to `happy`, if
  the figure has that mood, and lets go again after about a second and a
  half without one - a scene change while you are smiling still lands
  immediately, it is just the `happy` mood that keeps winning until the
  smile actually ends. A figure with no `happy` mood in its `states` simply
  never gets this: the scene name (or `?state=`) is the only thing deciding
  its mood, exactly as without a camera at all.
- **`?debug=1`** appended to the URL adds a small corner overlay: the raw
  camera preview and the live numbers (yaw/pitch, pointer, blink, mouth,
  mood) - for setting up a scene, not for streaming with. Leave it off once
  it looks right.

### Fallback: chroma key instead of `--enable-media-stream`

If starting OBS with a flag is not an option, `avatar.html` still runs fine
in a plain browser tab - Chrome, not OBS's embedded one - which needs no
flag for camera access at all:

1. Open `http://127.0.0.1:5173/addons/obs/avatar.html?figure=pedro&bg=00ff00`
   in Chrome and allow the camera prompt.
2. In OBS, add a **Window Capture** of that Chrome window (not a Browser
   Source - there is no browser source involved in this fallback at all).
3. Add a **Chroma Key** filter to the capture, keyed on the same green
   (`00ff00`). Expect soft edges - hair, a translucent hem - to keep a thin
   green fringe; a slightly different key colour or a touch of "Spill
   reduction" in the filter usually cleans that up, the same tradeoff any
   green-screen capture makes.

This loses the transparency `bg` normally replaces and needs its own window
kept open outside OBS, but it works on any OBS version at all, with no
camera-access flag anywhere.

## Why not a rendered video loop

A figure here deliberately runs its motions on periods that do not line up
with each other (see "secondary action" in `../../AGENTS.md`), and `breathe`
and `sway` each mix two sines at the golden ratio, whose combined period
never repeats at all. A rendered video has to end somewhere and start again,
and at that cut every motion jumps back to where it began - the seam the
studio's window loop shows on purpose. The engine is a function of time, so
this page simply keeps counting and never reaches a seam.
