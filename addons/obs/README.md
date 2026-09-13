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

## Why not a rendered video loop

A figure here deliberately runs its motions on periods that do not line up
with each other (see "secondary action" in `../../AGENTS.md`), and `breathe`
and `sway` each mix two sines at the golden ratio, whose combined period
never repeats at all. A rendered video has to end somewhere and start again,
and at that cut every motion jumps back to where it began - the seam the
studio's window loop shows on purpose. The engine is a function of time, so
this page simply keeps counting and never reaches a seam.
