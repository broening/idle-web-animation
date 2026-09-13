/*!
 * scene.js - OBS Studio glue for the figure page.
 *
 * Everything here is optional sugar around window.obsstudio, the API the
 * obs-browser plugin injects into a Browser Source. Outside OBS - a plain
 * tab, a browser without the plugin, a source whose page permission is set
 * too low to see scene names - window.obsstudio is either missing entirely
 * or present but unable to answer, and every function below has to fall back
 * to doing nothing rather than let that reach the page as a visible error.
 *
 * matchState() is the one pure function, and the only thing the Node test
 * exercises: no window, no obsstudio, no DOM. watchScene() and params() are
 * browser-only, but still checked defensively so requiring this file in Node
 * (which never calls them) cannot throw either.
 *
 * Chromium 103 is the floor here too, same as the rest of the repo - see
 * AGENTS.md and tools/check-compat.py.
 */
(function (global) {
  'use strict';

  /* Turn an OBS scene name into one of the figure's state names.
   *
   * Scene names are free text a person types once in OBS and forgets about,
   * so the match has to be forgiving: case does not matter, and any run of
   * characters that are not lowercase letters, digits, "_" or "-" splits one
   * word from the next - the same alphabet figure.json state names are
   * restricted to (see the "states" contract in gates/PLAN.md), so a scene
   * word can only ever match a real state by being that state's exact name,
   * never a prefix or part of a hyphenated compound: "sad-ish" stays one
   * word, and that word is not "sad".
   *
   * The first word in scene order that is a known state wins, so a scene
   * called "Just Chatting happy" or "Pause sad" finds the mood word wherever
   * it sits, and a scene with no mood word at all falls through to
   * `fallback` - figure.html passes its own ?state= start mood there, or
   * "neutral" if even that was not given. */
  function matchState(sceneName, stateNames, fallback) {
    var names = stateNames || [];
    var text = (typeof sceneName === 'string') ? sceneName : '';
    var words = text.toLowerCase().split(/[^a-z0-9_-]+/);
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;                 /* split() can yield empty strings */
      for (var j = 0; j < names.length; j++) {
        if (names[j] === w) return w;
      }
    }
    return fallback;
  }

  /* Ask OBS which scene is live, once now and again on every change.
   *
   * window.obsstudio.getCurrentScene(cb) and the "obsSceneChanged" event are
   * the two calls the obs-browser plugin documents (its README, at
   * https://github.com/obsproject/obs-browser). Both need the browser
   * source's page permission raised to at least "Read User Data" - see
   * addons/obs/README.md for the exact setting. Below that level the object
   * may be present but simply never call back, so every step here is
   * guarded rather than assumed to work; outside OBS altogether
   * window.obsstudio does not exist and this function does nothing at all. */
  function watchScene(cb) {
    if (typeof window === 'undefined' || !window.obsstudio) return;
    var obsstudio = window.obsstudio;

    function safeCb(name) {
      try {
        cb(name);
      } catch (e) {
        if (window.console && console.error) {
          console.error('IdleObs.watchScene callback failed', e);
        }
      }
    }

    try {
      if (typeof obsstudio.getCurrentScene === 'function') {
        obsstudio.getCurrentScene(function (scene) {
          if (scene && typeof scene.name === 'string') safeCb(scene.name);
        });
      }
    } catch (e) {
      if (window.console && console.error) {
        console.error('IdleObs.watchScene getCurrentScene failed', e);
      }
    }

    try {
      window.addEventListener('obsSceneChanged', function (event) {
        if (event && event.detail && typeof event.detail.name === 'string') {
          safeCb(event.detail.name);
        }
      });
    } catch (e) {
      if (window.console && console.error) {
        console.error('IdleObs.watchScene listener failed', e);
      }
    }
  }

  /* The three query parameters figure.html cares about, read once. Every
   * value comes back as a string or undefined - figure.html still validates
   * each one against its own pattern before trusting it, the same as any
   * other URL a person can type has to be treated as hostile input. */
  function params() {
    var out = { figure: undefined, state: undefined, bg: undefined };
    if (typeof window === 'undefined' || !window.location) return out;
    try {
      var sp = new URLSearchParams(window.location.search || '');
      out.figure = sp.get('figure') || undefined;
      out.state = sp.get('state') || undefined;
      out.bg = sp.get('bg') || undefined;
    } catch (e) {
      /* A malformed query string is not worth failing the whole page over. */
    }
    return out;
  }

  var api = {
    matchState: matchState,
    watchScene: watchScene,
    params: params
  };

  global.IdleObs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
