/*
 * studio.js - the authoring and checking surface for idle.js.
 *
 * Everything here runs in the page. No npm, no build, no headless browser.
 * The contact sheet, the size export and the IoU check all reuse the same
 * solve() output the player uses, so what you check is what will ship.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var FIGURES_ROOT = '../figures/';
  /* Marks a figure that exists only in this page. A NUL byte used to do
   * this job; it also made the file binary to git, so a whole commit's
   * worth of changes showed up as "Bin 34013 -> 39025 bytes". */
  var UNSAVED = '~unsaved~';

  var state = {
    name: null,
    figure: null,
    fig: null,          /* the mounted IdleFigure */
    images: null,       /* preloaded Image bank, for canvas work */
    selected: null,     /* layer id */
    dragging: false,
    nudging: null,      /* last stage point of an alt-drag, in canvas pixels */
    panning: null,      /* pointer and pan at the start of a view drag */
    painting: false,    /* a brush stroke is in progress on the mask */
    placing: null,      /* grab offset while a part is being placed */
    window: 8,
    stageBg: null,  /* null = transparent, else a css colour */
    unsaved: {},    /* figures that live only in this page, by name */
    /* Which mood the panel is editing. Studio state, never saved: the file
     * only ever remembers a mood by what it changes, not which one someone
     * happened to be looking at. 'neutral' means the layers as written. */
    mood: 'neutral',
    hasApi: false,     /* tools/serve.py answered /_studio, read-only or not */
    srcOptions: null    /* this figure's layers/ files, for a mood's picture field */
  };

  /* ================================================================== *
   * Figure discovery
   * ================================================================== */

  function listFigures() {
    return fetch(FIGURES_ROOT + 'index.json')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(0); })
      .catch(function () {
        /* No curated index.json - ask our own server for the real folders,
         * rather than reach straight for the directory listing below. A
         * listing's HTML has been seen arriving truncated mid-tag on this
         * machine (see /_files and /_figures in serve.py), which turned a
         * folder of twelve files into six and would just as quietly turn a
         * figures/ of five figures into two. */
        return fetch('/_figures')
          .then(function (r) { return r.ok ? r.json() : Promise.reject(0); })
          .then(function (d) { return d.names; });
      })
      .catch(function () {
        /* Neither of the above: a plain `python -m http.server`, or our own
         * server started from some other working directory. The one thing
         * left to try, known unreliable on this machine but better than
         * nothing on a server that has no other route to ask. */
        return fetch(FIGURES_ROOT)
          .then(function (r) { return r.text(); })
          .then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var out = [];
            var as = doc.querySelectorAll('a[href]');
            for (var i = 0; i < as.length; i++) {
              var h = as[i].getAttribute('href');
              if (h && h.charAt(h.length - 1) === '/' && h.indexOf('..') < 0) {
                out.push(decodeURIComponent(h.replace(/\/$/, '')));
              }
            }
            return out;
          });
      });
  }

  /* Which of these names still have a figure.json to load. A folder can
   * vanish outside the studio entirely - deleted by hand, moved, a git
   * checkout that dropped it - and figures/index.json has no way to find
   * out until something actually asks. A HEAD works on any server, ours or
   * a plain `python -m http.server`, because it is nothing more than the
   * request loadFigure() already makes. */
  function partitionByExistence(names) {
    return Promise.all(names.map(function (n) {
      return fetch(FIGURES_ROOT + n + '/figure.json', { method: 'HEAD' })
        .then(function (r) { return r.ok; })
        .catch(function () { return false; });
    })).then(function (alive) {
      var live = [], gone = [];
      for (var i = 0; i < names.length; i++) (alive[i] ? live : gone).push(names[i]);
      return { live: live, gone: gone };
    });
  }

  /* Best-effort tidy-up, never load-bearing: the list already works from
   * `live` regardless of whether this succeeds. Only touches index.json when
   * it actually names one of the missing figures, so it never manufactures
   * one out of a directory-listing fallback or overwrites a curation the
   * file does not otherwise have. */
  function forgetGhosts(names) {
    if (!state.canWrite || !names.length) return;
    fetch(FIGURES_ROOT + 'index.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (idx) {
        if (!Array.isArray(idx)) return;
        var kept = idx.filter(function (n) { return names.indexOf(n) < 0; });
        if (kept.length === idx.length) return;
        return putFile(FIGURES_ROOT + 'index.json',
                       JSON.stringify(kept) + '\n', 'application/json');
      })
      .catch(function () {});
  }

  /* keepDirty: mount a figure that did NOT come off the disk, so the Save
   * button keeps knowing there is something to save. The JSON box is the
   * only caller that needs it. */
  function mountFigure(name, fig, base, keepDirty) {
    state.name = name;
    state.figure = fig;
    state.base = base;
    state.selected = null;
    /* A mood picked while looking at the last figure means nothing on this
     * one - it may not even have a mood of that name. */
    state.mood = 'neutral';
    /* A new figure starts with every layer on. Carrying the eye state across
     * would hide a layer of the new figure that happens to share an id. */
    state.hidden = {};
    /* And it starts whole. A pan left over from the last figure would put
     * the next one somewhere off the edge, which reads as a figure that
     * failed to load. */
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    state.window = (fig.motion && fig.motion.windowSeconds) || 8;
    $('scrub').max = String(state.window);
    $('scrub').value = '0';

    if (state.fig) state.fig.pause();
    /* The studio never mounts the figure's own backdrop - see the background
     * note in idle.js. The field stays in figure.json for the target that
     * wants it; here it would only be noise behind the thing being judged. */
    state.fig = new Idle.IdleFigure($('stage'), fig, base, { background: false });
    state.fig.loop = $('loopWindow').checked ? state.window : 0;
    state.fig.play();
    $('playBtn').textContent = 'Pause';

    buildMoodCard();
    buildLayerList();
    buildLayerCard();
    buildMotionControls();
    buildIouTruthList();
    /* A mask belongs to one picture. Carrying it to the next figure
     * would paint marks over something they were never drawn on. */
    marks.parts = [];
    if (marks.ctx) marks.ctx.clearRect(0, 0, $('marks').width, $('marks').height);
    sizeMarks();
    if (marks.on) setMarkMode(false);
    clearPlace();
    refreshAddFrom();
    refreshSrcOptions();
    refitStage();
    $('sheet').width = 0;
    $('eventsOut').textContent = '';
    $('iouTable').innerHTML = '';

    /* Whatever was just mounted is, by definition, what is on disk. Every
     * later edit is measured against this string. */
    if (!keepDirty) {
      markClean();
      resetHistory();
    }

    state.images = null;
    var mine = ++imageLoads;
    return Idle.loadImages(fig, base).then(function (imgs) {
      if (mine === imageLoads) state.images = imgs;
    });
  }

  function loadFigure(name) {
    var base = FIGURES_ROOT + name + '/';
    return fetch(base + 'figure.json')
      .then(function (r) {
        if (!r.ok) throw new Error('no figure.json in ' + name);
        return r.json();
      })
      .then(function (fig) { return mountFigure(name, fig, base); });
  }

  /* ------------------------------------------------------------------ *
   * Starting from a flat image.
   *
   * This is where a figure actually begins: one PNG, straight out of the
   * drawing. It mounts as a single layer that breathes, which is enough to
   * see it live. Splitting it into parts is the next step, not this one.
   * ------------------------------------------------------------------ */

  function newFromImage(file) {
    /* Kept because the cutter reads the flat picture off disk, and
     * this is the only copy of it the page ever has. */
    marks.sourceFile = file;
    var url = URL.createObjectURL(file);
    return loadImg(url).then(function (img) {
      /* The name came off a file name, and a file name is allowed things a
       * folder on this server is not: capitals, spaces, umlauts. It used to
       * come straight through, and the first request that carried it - the
       * cut - came back "unzulaessiger Figurenname" with nothing to say
       * which name or why. `Kriegerin II.png` becomes `kriegerin-ii`. */
      var name = figureName(file.name.replace(/\.[^.]+$/, '')) || 'figur';
      var ext = (file.name.match(/\.([a-zA-Z0-9]+)$/) || [null, 'png'])[1].toLowerCase();
      var path = 'layers/whole.' + ext;
      var fig = {
        name: name,
        note: 'Started from ' + file.name + '. One layer so far.',
        size: { width: img.naturalWidth, height: img.naturalHeight },
        motion: { windowSeconds: 8, followSeconds: 0.085, parallax: 0.35 },
        /* Display only. The layer keeps a real path so the export writes a
         * folder that something can actually open. */
        sources: {},
        layers: [{
          id: 'whole',
          src: path,
          alt: name,
          /* Hips, roughly. A whole figure breathing about its own centre
           * looks like it is inflating; about the hips it looks alive. */
          pivot: [0.5, 0.95],
          depth: 0.3,
          motions: [{ type: 'breathe', strength: 1.0, period: 4.0 }]
        }]
      };
      fig.sources[path] = url;

      var sel = $('figureSel');
      var found = false;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === UNSAVED + name) found = true;
      }
      if (!found) {
        var o = document.createElement('option');
        o.value = UNSAVED + name;
        o.textContent = name + '  (unsaved)';
        sel.insertBefore(o, sel.firstChild);
      }
      sel.value = UNSAVED + name;
      state.unsaved[name] = fig;

      return mountFigure(name, fig, '');
    });
  }

  /* ================================================================== *
   * Creating, uploading, saving, resetting
   *
   * `python -m http.server` cannot write, which is why the only ways out of
   * this studio used to be a zip or a block of JSON to paste somewhere by
   * hand. `tools/serve.py` serves the same files and additionally answers PUT
   * inside figures/ and can run the importer. Everything here switches itself
   * off, with the reason on screen, when the read-only server is the one
   * answering - guessing and failing later would be worse.
   * ================================================================== */

  state.canWrite = false;
  state.saved = '';                     /* the figure exactly as it is on disk */

  var NAME_OK = /^[a-z0-9][a-z0-9._-]{0,63}$/;

  /* Fold any text into a name this server will accept as a folder. The same
   * rule as NAME_OK above and as serve.py, applied instead of tested, so a
   * name the studio makes up itself can never be one the server refuses. */
  function figureName(text) {
    var s = String(text || '').toLowerCase()
      .replace(/[äæ]/g, 'ae').replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9._-]+/g, '-');
    while (s.indexOf('--') >= 0) s = s.replace(/--/g, '-');
    s = s.replace(/^[-._]+/, '').replace(/[-._]+$/, '');
    return s.slice(0, 64);
  }

  function say(msg) { $('figureOut').textContent = msg || ''; }

  function figureJson() { return JSON.stringify(state.figure, null, 2) + '\n'; }

  /* Comparing the serialised figure is exact and costs nothing worth saving.
   * Tracking a dirty flag through every slider, pivot drag and reorder is the
   * version that quietly goes wrong. */
  function isDirty() { return !!state.figure && figureJson() !== state.saved; }

  function markClean() {
    state.saved = state.figure ? figureJson() : '';
    refreshSaveState();
  }

  /* `state.base` is '' for a figure that only exists in this page (an
   * upload from "Flat image...") and a real path for one that was actually
   * read off the server, so its truthiness already says which this is - no
   * name comparison needed, and none of the ambiguity one would have: two
   * figures can share a name (an unsaved draft and an on-disk figure of the
   * same name are different values under different dropdown options), but
   * the currently mounted one is never in doubt about where it came from.
   *
   * This used to compare state.name against the literal sentinel UNSAVED,
   * which is never what state.name actually holds - the sentinel is only
   * ever a *prefix* on a <select> option's value (UNSAVED + name), so this
   * check was true for every figure, on disk or not. Save then wrote a
   * figure.json for an unsaved flat image straight to
   * figures/<name>/figure.json, pointing at a layer image that was never
   * uploaded - the blob: URL holding it dies with the tab. */
  function onDisk() { return !!(state.name && state.base); }

  function refreshSaveState() {
    $('saveBtn').disabled = !state.canWrite || !onDisk();
    $('resetBtn').disabled = !onDisk();
    $('newFigureBtn').disabled = !state.canWrite;
    $('partsInput').disabled = !state.canWrite;
    /* Discarding an unsaved figure needs no server at all, so this is not
     * gated on state.canWrite - only on there being a figure to discard. */
    $('deleteFigureBtn').disabled = !state.figure;
    var s = $('serverState');
    if (!state.canWrite) {
      s.textContent = 'Read-only server. Run  python tools/serve.py  to create, '
                    + 'upload and save.';
      return;
    }
    if (!state.figure) { s.textContent = 'No figure loaded.'; return; }
    if (!onDisk()) { s.textContent = 'This figure is not on disk yet.'; return; }
    s.textContent = isDirty() ? 'Unsaved changes.' : 'Saved.';
  }

  function probeServer() {
    /* A route that only tools/serve.py has. Guessing from a failed PUT is
     * worse: http.server answers 501 for a method it does not know, and
     * anything in between could answer something else again. */
    return fetch('/_studio')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) {
        state.canWrite = !!(j && j.write);
        /* tools/serve.py answered at all - true even in its read-only mode,
         * since /_files is a GET and needs no write permission. A mood's
         * picture field uses this to offer a select of real files instead of
         * a bare text box; a plain `python -m http.server` has no such
         * route, so this stays false there. */
        state.hasApi = !!j;
        refreshSaveState();
        refreshSrcOptions();
      });
  }

  function putFile(path, body, type) {
    return fetch(path, { method: 'PUT', headers: { 'Content-Type': type }, body: body })
      .then(function (r) {
        return r.text().then(function (txt) {
          var j = {};
          try { j = JSON.parse(txt); } catch (e) { j = {}; }
          if (!r.ok) throw new Error(j.error || (path + ' -> ' + r.status));
          return j;
        });
      });
  }

  function saveFigure() {
    if (!state.canWrite || !onDisk()) return Promise.resolve();
    return putFile(FIGURES_ROOT + state.name + '/figure.json', figureJson(),
                   'application/json')
      .then(function () {
        markClean();
        say('Saved figures/' + state.name + '/figure.json');
      });
  }

  function resetFigure() {
    if (!onDisk()) return;
    if (isDirty() && !window.confirm(
        'Throw the unsaved changes away and reload figures/' + state.name +
        '/figure.json from disk?')) return;
    loadFigure(state.name)
      .then(function () { say('Reloaded from disk.'); })
      .catch(showError);
  }

  /* ------------------------------------------------------------------ *
   * Undo.
   *
   * The figure is one JSON text, and isDirty() already compares that text,
   * so the history is simply a stack of those texts. Nothing has to be
   * threaded through the thirty-odd places that edit the figure: a step is
   * taken whenever the text has changed and the pointer is not held down,
   * which makes a whole slider drag or pivot drag one step, not a hundred.
   *
   * The history starts fresh with every figure that comes off the disk, and
   * after anything that deleted files: undoing a removed layer would bring
   * back a layer whose image is gone.
   * ------------------------------------------------------------------ */
  var HISTORY_MAX = 100;
  var undos = { past: [], future: [], top: '' };
  var pressed = false;   /* a button is held somewhere on the page */
  var imageLoads = 0;    /* the last restore()'s image load wins */

  function resetHistory() {
    undos.past = [];
    undos.future = [];
    undos.top = state.figure ? figureJson() : '';
    refreshUndoState();
  }

  function checkpoint() {
    if (!state.figure || pressed) return;
    var now = figureJson();
    if (now === undos.top) return;
    if (undos.top) undos.past.push(undos.top);
    if (undos.past.length > HISTORY_MAX) undos.past.shift();
    undos.future = [];
    undos.top = now;
    refreshUndoState();
  }

  function refreshUndoState() {
    $('undoBtn').disabled = !undos.past.length;
    $('redoBtn').disabled = !undos.future.length;
  }

  function imagePaths(f) {
    var out = [(f && f.background) || ''];
    var layers = (f && f.layers) || [];
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      out.push(L.id + '=' + ((L.frames && L.frames.length) ? L.frames.join('|') : L.src));
    }
    /* Mood pictures are loaded into the same image bank (Idle.loadImages
     * loads every state src too), so a mood's src changing under undo or the
     * JSON box has to trigger the same reload a layer's own src changing
     * does - otherwise the canvas work goes on drawing whatever was loaded
     * before, for a picture the page itself shows correctly. */
    if (f && Idle && typeof Idle.imagesOf === 'function') {
      for (i = 0; i < layers.length; i++) {
        var pics = Idle.imagesOf(layers[i], f);
        var srcs = [];
        for (var k = 0; k < pics.length; k++) srcs.push(pics[k].src);
        out.push(layers[i].id + '~' + srcs.join('|'));
      }
    }
    return out.join('\n');
  }

  /* Put a stored text back without remounting. mountFigure() would throw
   * away the zoom, the selection and the marks; this keeps all three. */
  function restore(text) {
    var old = state.figure;
    state.figure = JSON.parse(text);
    undos.top = text;
    /* A figure that only lives in this page is held in state.unsaved too,
     * and switching away and back reads it from there. */
    if (state.unsaved[state.name] === old) state.unsaved[state.name] = state.figure;
    if (!selectedLayer()) state.selected = null;
    /* Undo past the mood being renamed or deleted leaves nothing of that
     * name to look at any more - back to neutral rather than a select box
     * with a value it no longer offers. */
    if (Idle.stateNames(state.figure).indexOf(state.mood) < 0) state.mood = 'neutral';

    rebuildStage();
    buildMoodCard();
    buildLayerList();
    buildLayerCard();
    buildMotionControls();
    refreshSaveState();
    refreshUndoState();

    /* The canvas work (contact sheet, export) needs the image bank to match
     * the layers. Only reload it when the layers or their files changed. */
    if (imagePaths(old) !== imagePaths(state.figure)) {
      var mine = ++imageLoads;
      state.images = null;
      Idle.loadImages(state.figure, state.base)
        .then(function (imgs) { if (mine === imageLoads) state.images = imgs; })
        .catch(function (e) { say(String((e && e.message) || e)); });
    }
  }

  function undo() {
    /* An edit still settling is a step of its own, so it is what goes. */
    checkpoint();
    if (!undos.past.length) return;
    undos.future.push(undos.top);
    restore(undos.past.pop());
  }

  function redo() {
    checkpoint();
    if (!undos.future.length) return;
    undos.past.push(undos.top);
    restore(undos.future.pop());
  }

  /* Ctrl+Z inside a text box belongs to the text box. A slider or a
   * checkbox has no undo of its own, so there it means the figure. */
  function typingIn(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
    if (el.tagName !== 'INPUT') return false;
    return !/^(range|checkbox|radio|button|color|file)$/i.test(el.type || 'text');
  }

  function bindUndo() {
    window.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      var k = (e.key || '').toLowerCase();
      var back = k === 'z' && !e.shiftKey;
      var fwd = k === 'y' || (k === 'z' && e.shiftKey);
      if (!back && !fwd) return;
      if (typingIn(e.target)) return;
      e.preventDefault();
      if (back) undo(); else redo();
    });
    $('undoBtn').addEventListener('click', undo);
    $('redoBtn').addEventListener('click', redo);

    /* Capture phase, so a handler that stops the event cannot hide it. */
    window.addEventListener('pointerdown', function () { pressed = true; }, true);
    function released() {
      pressed = false;
      /* After the page's own handlers have written their last value. */
      setTimeout(checkpoint, 0);
    }
    window.addEventListener('pointerup', released, true);
    window.addEventListener('pointercancel', released, true);
    /* A drag let go outside the window may never send its pointerup. */
    window.addEventListener('blur', released);
    window.addEventListener('keyup', function () { setTimeout(checkpoint, 0); }, true);
    window.addEventListener('change', function () { setTimeout(checkpoint, 0); }, true);

    /* Closing the tab throws away unsaved edits and every figure that only
     * lives in this page. The browser shows its own wording; a custom
     * message has not been honoured for years. */
    window.addEventListener('beforeunload', function (e) {
      if (!isDirty() && !Object.keys(state.unsaved).length) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  function registerFigure(name) {
    return fetch(FIGURES_ROOT + 'index.json')
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; })
      .then(function (names) {
        if (!names || names.indexOf(name) >= 0) return null;
        names.push(name);
        return putFile(FIGURES_ROOT + 'index.json',
                       JSON.stringify(names) + '\n', 'application/json');
      });
  }

  function createFigure() {
    var name = ($('newName').value || '').trim().toLowerCase();
    if (!NAME_OK.test(name)) {
      say('A name may hold a-z, 0-9, dot, dash and underscore, and has to '
        + 'start with a letter or a digit.');
      return;
    }
    /* No layers on purpose. The importer treats an empty list as "no rig to
     * keep" and builds one from the parts, which is exactly what should
     * happen the first time they are uploaded. */
    var fig = {
      name: name,
      note: 'Created in the studio. No parts yet.',
      size: { width: 1000, height: 1000 },
      motion: { windowSeconds: 8, followSeconds: 0.085, parallax: 0.25 },
      layers: []
    };
    say('creating figures/' + name + ' ...');
    putFile(FIGURES_ROOT + name + '/figure.json',
            JSON.stringify(fig, null, 2) + '\n', 'application/json')
      .then(function () { return registerFigure(name); })
      .then(function () { return refreshFigureList(name); })
      .then(function () {
        $('newName').value = '';
        say('figures/' + name + ' created. Upload its parts next.');
      })
      .catch(function (e) { say(String((e && e.message) || e)); });
  }

  /* Deletes the whole figure - its folder, every image in it, and its entry
   * in figures/index.json - not just the entry in the picker. Leaving the
   * folder behind would mean the next thing to list figures/ finds it again,
   * which is the exact bug on the other side of this feature: a figure that
   * will not go away versus one that is still listed after it already has.
   */
  function deleteFigure() {
    if (!state.figure || !state.name) return;
    var name = state.name;

    if (!onDisk()) {
      /* Never touched the server, so there is nothing there to remove.
       * Forgetting it here is the whole of what "deleting" it means.
       *
       * Deliberately not a call to refreshFigureList(): that rebuilds the
       * picker from the disk listing alone, and an in-page figure is not on
       * it - two flat images dropped in before either was saved would lose
       * the other the moment one of them was discarded. */
      delete state.unsaved[name];
      var sel = $('figureSel');
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === UNSAVED + name) { sel.remove(i); break; }
      }
      var next = Object.keys(state.unsaved)[0];
      var after = next
        ? mountFigure(next, state.unsaved[next], '').then(function () {
            sel.value = UNSAVED + next;
          })
        : refreshFigureList();      /* nothing unsaved left - fall back to disk */
      return after.then(function () {
        say('Discarded "' + name + '". It was never saved.');
      });
    }
    if (!state.canWrite) { say('The server is read-only.'); return; }

    say('deleting figures/' + name + ' …');
    return fetch('/_figure?name=' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || 'delete failed (' + r.status + ')');
        });
      })
      .then(function () { return refreshFigureList(); })
      .then(function () {
        say('Deleted figures/' + name + ' and everything in it.');
      })
      .catch(function (e) { say(String((e && e.message) || e)); });
  }

  /* The server refuses anything outside a small character set, so fix the
   * name here rather than letting the upload fail halfway through a batch. */
  function cleanName(n) {
    var s = String(n).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.\-_]+/, '');
    return s || 'part.png';
  }

  function uploadParts(fileList) {
    if (!state.canWrite) return;
    if (!onDisk()) { say('Create a figure first, or pick one from the list.'); return; }
    var name = state.name;

    var files = [];
    for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
    /* Name order, front first - the same rule import-layers.py uses, applied
     * here too so what the studio shows and what the tool does cannot drift. */
    files.sort(function (a, b) {
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });

    /* The importer reads figure.json off the disk. Uploading on top of
     * unsaved edits would quietly import the older rig and throw the edits
     * away, so they go first. */
    var start = isDirty() ? saveFigure() : Promise.resolve();

    return start.then(function () {
      var chain = Promise.resolve();
      files.forEach(function (f, k) {
        chain = chain.then(function () {
          say('uploading ' + (k + 1) + ' of ' + files.length + ': ' + f.name);
          return putFile(FIGURES_ROOT + name + '/' + cleanName(f.name), f,
                         f.type || 'application/octet-stream');
        });
      });
      return chain;
    }).then(function () {
      say('running tools/import-layers.py ...');
      return fetch('/_import?name=' + encodeURIComponent(name), { method: 'POST' })
        .then(function (r) { return r.json(); });
    }).then(function (res) {
      if (!res.ok) throw new Error(res.err || res.error || 'import failed');
      return loadFigure(name).then(function () {
        say(files.length + ' part(s) in.\n' + (res.out || ''));
      });
    }).catch(function (e) { say(String((e && e.message) || e)); });
  }

  function refreshFigureList(pick) {
    return listFigures().then(function (names) {
      return partitionByExistence(names).then(function (p) {
        if (p.gone.length) forgetGhosts(p.gone);

        var sel = $('figureSel');
        sel.innerHTML = '';
        for (var i = 0; i < p.live.length; i++) {
          var o = document.createElement('option');
          o.value = p.live[i];
          o.textContent = p.live[i];
          sel.appendChild(o);
        }

        var want = (pick && p.live.indexOf(pick) >= 0) ? pick : p.live[0];
        if (!want) {
          unmountFigure();
          say(p.gone.length
            ? 'Nothing left: ' + p.gone.join(', ') + ' no longer exist on ' +
              'disk. Start from a flat image, or create one.'
            : 'No figures found under ' + FIGURES_ROOT);
          return null;
        }

        sel.value = want;
        return loadFigure(want).then(function (r) {
          if (p.gone.length) {
            say('Removed from the list, missing on disk: ' + p.gone.join(', ') + '.');
          }
          return r;
        });
      });
    });
  }

  /* The state after the last figure is gone - a fresh tab that has not
   * loaded one yet, reached here instead by deleting every figure there
   * was. Every card already guards against state.figure being null; this is
   * the one place that actually puts it there and clears what a stale
   * figure would otherwise leave on screen. */
  function unmountFigure() {
    if (state.fig) { state.fig.pause(); state.fig.destroy(); state.fig = null; }
    state.figure = null;
    state.name = null;
    state.selected = null;
    state.mood = 'neutral';
    state.hidden = {};
    state.images = null;
    state.saved = '';
    resetHistory();
    marks.parts = [];
    if (marks.on) setMarkMode(false);
    clearPlace();

    $('sheet').width = 0;
    $('eventsOut').textContent = '';
    $('iouTable').innerHTML = '';
    $('jsonOut').value = '';

    buildMoodCard();
    buildLayerList();
    buildLayerCard();
    buildMotionControls();
    buildIouTruthList();
    refreshAddFrom();
    drawOverlay();
    refreshSaveState();
  }

  /* ================================================================== *
   * Layer list and selection
   * ================================================================== */

  /* Which layers the eye is switched off for. Keyed by id, and deliberately
   * NOT part of the figure: this is a way of looking at the stage, not a
   * property of the character. The contact sheet ignores it, because the
   * sheet's whole job is to show what ships. */
  state.hidden = {};

  /* The stage is built once, in draw order, and the player only ever writes
   * transform, opacity and filter. So display and classList are free for the
   * studio to use, and a re-stack is just moving existing nodes. */
  function boxOf(id) {
    var stage = state.fig && state.fig.stage;
    if (!stage) return null;
    for (var i = 0; i < stage.children.length; i++) {
      if (stage.children[i].getAttribute('data-id') === id) return stage.children[i];
    }
    return null;
  }

  function applyHidden() {
    var layers = (state.figure && state.figure.layers) || [];
    for (var i = 0; i < layers.length; i++) {
      var box = boxOf(layers[i].id);
      if (box) box.style.display = state.hidden[layers[i].id] ? 'none' : '';
    }
  }

  /* Draw order changed, so the DOM has to say so. appendChild moves a node
   * that is already there, which is why this needs no remount and loses no
   * loaded image. */
  function restack() {
    var stage = state.fig && state.fig.stage;
    if (!stage) return;
    var layers = state.figure.layers || [];
    for (var i = 0; i < layers.length; i++) {
      var box = boxOf(layers[i].id);
      if (box) stage.appendChild(box);
    }
  }

  /* List position to array index. The list runs front to back and the array
   * runs back to front, so every drop has to be turned around. Getting this
   * backwards puts the cloak in front of the face and looks like a bug in the
   * renderer rather than in the arithmetic. */
  function listToArray(li, len) { return len - 1 - li; }

  function moveLayer(fromList, toList) {
    var layers = state.figure.layers || [];
    var n = layers.length;
    var from = listToArray(fromList, n);
    var to = listToArray(toList, n);
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    var moved = layers.splice(from, 1)[0];
    layers.splice(to, 0, moved);
    restack();
    buildLayerList();
  }

  var dragFrom = -1;

  function buildLayerList() {
    var ul = $('layerList');
    ul.innerHTML = '';
    var layers = state.figure ? (state.figure.layers || []) : [];
    $('layerCount').textContent = state.figure
      ? layers.length + (layers.length === 1 ? ' layer' : ' layers')
      : '';
    /* Draw order is back to front. Read it top to bottom as front to back,
     * the way a layer palette does. */
    for (var i = layers.length - 1; i >= 0; i--) {
      (function (L, listIndex) {
        var li = document.createElement('li');
        li.className = (L.id === state.selected ? 'on' : '') +
                       (state.hidden[L.id] ? ' dim' : '');
        li.draggable = true;
        li.setAttribute('data-li', String(listIndex));

        var grip = document.createElement('span');
        grip.className = 'grip';
        grip.textContent = '⋮⋮';
        grip.title = 'drag to change draw order';

        var eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'eye' + (state.hidden[L.id] ? ' off' : '');
        eye.textContent = state.hidden[L.id] ? '○' : '●';
        eye.title = 'show or hide on the stage - the contact sheet ignores this';
        eye.addEventListener('click', function (e) {
          /* Without this the row underneath also fires and the layer gets
           * selected every time the eye is clicked. */
          e.stopPropagation();
          state.hidden[L.id] = !state.hidden[L.id];
          applyHidden();
          buildLayerList();
        });

        var nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = L.id;
        /* The chain and the role, without spending a single pixel of a row
         * that is already full. The Layer card shows both properly. */
        nm.title = (L.parent ? 'child of ' + L.parent : 'root') +
                   (L.role ? '  ·  ' + L.role : '');

        var tags = document.createElement('span');
        tags.className = 'tags';
        tags.textContent = (L.motions || []).map(function (m) { return m.type; }).join(' ');

        var pv = document.createElement('span');
        pv.className = 'pv';
        var p = L.pivot || [0.5, 0.5];
        var nudged = offsetLabel(L);
        pv.textContent = p[0].toFixed(2) + ' / ' + p[1].toFixed(2) +
                         (nudged ? '  ✥' : '');
        pv.title = nudged ? ('nudged by' + nudged) : '';

        li.appendChild(grip);
        li.appendChild(eye);
        li.appendChild(nm);
        li.appendChild(tags);
        li.appendChild(pv);

        li.addEventListener('click', function () {
          state.selected = L.id;
          buildLayerList();
          buildLayerCard();
          buildMotionControls();
        });

        li.addEventListener('dragstart', function (e) {
          dragFrom = listIndex;
          li.className += ' dragging';
          /* Firefox refuses to start a drag without data on the transfer. */
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(listIndex));
          }
        });
        li.addEventListener('dragend', function () {
          dragFrom = -1;
          buildLayerList();
        });
        li.addEventListener('dragover', function (e) {
          if (dragFrom < 0 || dragFrom === listIndex) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          /* Mark the half being pointed at, so the drop lands where the line
           * is drawn rather than one row off. */
          var r = li.getBoundingClientRect();
          var after = (e.clientY - r.top) > r.height / 2;
          li.className = li.className.replace(/ over-\w+/g, '') +
            (after ? ' over-below' : ' over-above');
        });
        li.addEventListener('dragleave', function () {
          li.className = li.className.replace(/ over-\w+/g, '');
        });
        li.addEventListener('drop', function (e) {
          e.preventDefault();
          var r = li.getBoundingClientRect();
          var after = (e.clientY - r.top) > r.height / 2;
          var target = listIndex + (after ? 1 : 0);
          /* Removing the dragged row first shifts everything below it up by
           * one, so a drop below the source has to come back down by one. */
          if (dragFrom < target) target -= 1;
          moveLayer(dragFrom, target);
          dragFrom = -1;
        });

        ul.appendChild(li);
      })(layers[i], layers.length - 1 - i);
    }

    /* The selected layer's dot is drawn larger and labelled, so every change
     * of selection is a change to the overlay. This runs on all of them -
     * the row click, the pivot grab, a layer being removed - which is why
     * the flag is set here rather than at each of those call sites. */
    drawOverlay();
  }

  function selectedLayer() {
    var layers = state.figure ? (state.figure.layers || []) : [];
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].id === state.selected) return layers[i];
    }
    return null;
  }

  /* ================================================================== *
   * The parent chain
   *
   * Two small functions, kept side by side and free of the DOM, because
   * tools/test-agreement.mjs lifts them straight out of this file and runs
   * them. They are the only thing standing between the panel and a figure
   * whose chainDepth() never returns.
   * ================================================================== */

  /* Every id that reads `id` as an ancestor, plus `id` itself. The parent
   * dropdown offers everything outside this set, which is exactly the set
   * that cannot close a loop.
   *
   * Grown one pass at a time rather than walked upwards, because the JSON
   * textarea is allowed to hand us a figure that already has a ring in it,
   * and a plain walk on a ring never comes back. */
  function descendantIds(layers, id) {
    var out = {}, i, j;
    out[id] = true;
    for (j = 0; j < layers.length; j++) {
      var grew = false;
      for (i = 0; i < layers.length; i++) {
        var L = layers[i];
        if (out[L.id]) continue;
        if (L.parent && out[L.parent]) { out[L.id] = true; grew = true; }
      }
      /* A pass that adds nothing means the set is closed. On a ring that is
       * the pass right after the one that closed it. */
      if (!grew) break;
    }
    return out;
  }

  /* null when the chain is sound, otherwise one sentence saying what is
   * wrong. A ring and a parent that does not exist are both fatal, and in
   * the same place: the engine walks the chain on every single frame. */
  function cycleTrouble(layers) {
    var have = {}, i, k;
    for (i = 0; i < layers.length; i++) have[layers[i].id] = layers[i];
    for (i = 0; i < layers.length; i++) {
      var L = layers[i];
      if (!L.parent) continue;
      if (!have[L.parent]) {
        return 'layer "' + L.id + '" has parent "' + L.parent +
               '", which is not a layer';
      }
      var at = have[L.parent], steps = 0;
      while (at && steps++ <= layers.length) {
        if (at.id === L.id) {
          return 'parent loop: "' + L.id + '" ends up as its own ancestor';
        }
        at = at.parent ? have[at.parent] : null;
      }
    }
    return null;
  }
  /* What has to be true before a hand-typed figure may go on the stage.
   *
   * Not a schema. The engine already defends itself against a bad number,
   * and the panel is not the place to re-state every field. These are the
   * mistakes that end in a frozen tab or in the studio pointing at a layer
   * that is not there. */
  function figureTrouble(fig) {
    if (!fig || typeof fig !== 'object' || Array.isArray(fig)) {
      return 'the top level has to be an object';
    }
    if (!Array.isArray(fig.layers) || !fig.layers.length) {
      return '"layers" has to be a list with at least one layer in it';
    }
    var seen = {};
    for (var i = 0; i < fig.layers.length; i++) {
      var L = fig.layers[i];
      if (!L || typeof L !== 'object' || Array.isArray(L)) {
        return 'layer ' + i + ' is not an object';
      }
      if (typeof L.id !== 'string' || !L.id) {
        return 'layer ' + i + ' has no id';
      }
      /* The engine survives a duplicate id - first wins - but the studio
       * does not: the eye toggles, the pivot drag and boxOf() all key on
       * it, so the second copy would be unreachable and the first would
       * answer for both. */
      if (seen[L.id]) return 'two layers share the id "' + L.id + '"';
      seen[L.id] = true;
      if (!L.src && !(L.frames && L.frames.length)) {
        return 'layer "' + L.id + '" has neither src nor frames';
      }
    }
    return cycleTrouble(fig.layers);
  }
  /* end of the parent-chain guard */

  /* ================================================================== *
   * Moods ("states")
   *
   * A mood is a second look for the same rig, kept as a table of overrides
   * against the layers as written. The panel edits one mood at a time -
   * state.mood, studio state, never saved - and every write below lands in
   * figure.states[state.mood][layerId], never in the layer itself. Neutral
   * (state.mood === 'neutral') is the ordinary path through every card and
   * takes none of this.
   *
   * Four small functions carry the whole contract: moodOverrideOf reads a
   * layer's table for the current mood, hasOverride/overrideVal read one key
   * of it (falling back to the neutral value the panel was handed), and
   * setOverride/clearOverride write and prune it. `group` is null for a
   * layer-level key (offset, tilt, hidden, src) and a motion type name for
   * one of that motion's parameters - the same two shapes docs/figure-json.md
   * describes under "What a mood can change".
   * ================================================================== */

  function moodTable() {
    if (state.mood === 'neutral') return null;
    var f = state.figure;
    return (f && f.states && f.states[state.mood]) || null;
  }

  function moodOverrideOf(layerId) {
    var t = moodTable();
    return (t && Object.prototype.hasOwnProperty.call(t, layerId)) ? t[layerId] : null;
  }

  function hasOverride(layerId, group, key) {
    var ov = moodOverrideOf(layerId);
    if (!ov) return false;
    return group
      ? !!(ov[group] && Object.prototype.hasOwnProperty.call(ov[group], key))
      : Object.prototype.hasOwnProperty.call(ov, key);
  }

  /* The value a mood shows for one key, or `fallback` - the neutral value the
   * caller already has - when the mood does not touch it. This is "show
   * values as the mood sees them": the override where there is one, the
   * layer's own value otherwise. */
  function overrideVal(layerId, group, key, fallback) {
    var ov = moodOverrideOf(layerId);
    if (!ov) return fallback;
    var v = group ? (ov[group] && ov[group][key]) : ov[key];
    return v === undefined ? fallback : v;
  }

  /* isPlain guards every level here, not just the top one: a figure typed by
   * hand (or pasted into the JSON box) may hold `states.sad.kopf` as a string
   * or a number, which checkStates() already reports as a problem - but this
   * file runs 'use strict', and writing a property onto a primitive throws
   * there instead of quietly doing nothing. A click that overrides a field
   * must not crash the panel over a mistake the JSON card would explain. */
  function isPlain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function setOverride(layerId, group, key, value) {
    var f = state.figure;
    if (!isPlain(f.states)) f.states = {};
    if (!isPlain(f.states[state.mood])) f.states[state.mood] = {};
    var slot = f.states[state.mood];
    if (!isPlain(slot[layerId])) slot[layerId] = {};
    if (group) {
      if (!isPlain(slot[layerId][group])) slot[layerId][group] = {};
      slot[layerId][group][key] = value;
    } else {
      slot[layerId][key] = value;
    }
  }

  /* Deletes one key and prunes what is left empty: the parameter object, then
   * the layer's own entry. The mood itself is never pruned here, even down to
   * {} - clearing every override a mood makes must not make the mood vanish
   * out from under whoever has it selected. */
  function clearOverride(layerId, group, key) {
    var f = state.figure;
    var tab = f && f.states && f.states[state.mood];
    var ov = tab && tab[layerId];
    if (!ov) return;
    if (group) {
      if (ov[group]) {
        delete ov[group][key];
        if (!Object.keys(ov[group]).length) delete ov[group];
      }
    } else {
      delete ov[key];
    }
    if (!Object.keys(ov).length) delete tab[layerId];
  }

  /* Push the mood the panel has selected onto the mounted figure, with no
   * blend - a string state, never the {from,to,since} shape setState()
   * builds. That is deliberate: the panel is not asking for a transition, it
   * is asking to see one mood, so what shows should be exactly it. */
  function applyMoodToFig() {
    if (!state.fig) return;
    state.fig.state = state.mood;
    state.fig._stateMix = state.mood;
    if (!state.fig.playing) state.fig.render(state.fig.time);
  }

  /* ctx.state for anything that renders off the figure data directly -
   * the contact sheet and (inline, see scanEvents below) the event scan. The
   * player itself reads state.fig._stateMix through applyMoodToFig(). */
  function moodCtxState() {
    return state.mood === 'neutral' ? undefined : state.mood;
  }

  function moodSay(msg) {
    var el = $('moodOut');
    if (el) el.textContent = msg || '';
  }

  function setMood(name) {
    state.mood = name;
    refreshMoodEverything();
  }

  /* Called after anything that changes which mood is selected, or what moods
   * there are - a switch, a create, a rename, a delete. Locked fields in the
   * Layer and Motion cards depend on state.mood, so both are rebuilt, not
   * only refreshed in place. */
  function refreshMoodEverything() {
    applyMoodToFig();
    buildMoodCard();
    buildLayerCard();
    buildMotionControls();
    refreshStill();
    refreshSaveState();
  }

  var MOOD_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

  function createMood() {
    if (!state.figure) return;
    var raw = window.prompt('Name for the new mood - lowercase letters, digits, '
      + '- and _, starting with a letter or digit, at most 32 characters:', '');
    if (raw === null) return;
    var name = raw.trim().toLowerCase();
    if (name === 'neutral') {
      moodSay('"neutral" is the layers as written - it cannot be a mood of its own.');
      return;
    }
    if (!MOOD_NAME.test(name)) {
      moodSay('"' + raw + '" is not a usable mood name.');
      return;
    }
    if (state.figure.states && Object.prototype.hasOwnProperty.call(state.figure.states, name)) {
      moodSay('"' + name + '" already exists.');
      return;
    }
    if (!state.figure.states) state.figure.states = {};
    state.figure.states[name] = {};
    setMood(name);
    moodSay('Created "' + name + '". Every field it does not change stays neutral.');
  }

  function renameMood() {
    if (!state.figure || state.mood === 'neutral') return;
    var old = state.mood;
    var raw = window.prompt('New name for "' + old + '":', old);
    if (raw === null) return;
    var name = raw.trim().toLowerCase();
    if (name === old) return;
    if (name === 'neutral') {
      moodSay('"neutral" is the layers as written - it cannot be a mood of its own.');
      return;
    }
    if (!MOOD_NAME.test(name)) {
      moodSay('"' + raw + '" is not a usable mood name.');
      return;
    }
    if (state.figure.states && Object.prototype.hasOwnProperty.call(state.figure.states, name)) {
      moodSay('"' + name + '" already exists.');
      return;
    }
    state.figure.states[name] = state.figure.states[old];
    delete state.figure.states[old];
    state.mood = name;
    refreshMoodEverything();
    moodSay('Renamed "' + old + '" to "' + name + '".');
  }

  function deleteMood() {
    if (!state.figure || state.mood === 'neutral') return;
    var name = state.mood;
    if (!window.confirm('Delete the mood "' + name + '"? Every difference it holds is lost.')) return;
    if (state.figure.states) {
      delete state.figure.states[name];
      /* Leave states out of the file entirely once the last mood is gone,
       * rather than an empty object nobody put there on purpose. */
      if (!Object.keys(state.figure.states).length) delete state.figure.states;
    }
    state.mood = 'neutral';
    refreshMoodEverything();
    moodSay('Deleted "' + name + '".');
  }

  function buildMoodCard() {
    var box = $('moodCtl');
    if (!box) return;
    box.innerHTML = '';
    if (!state.figure) {
      box.appendChild(hintLine('No figure loaded.'));
      return;
    }

    var names = Idle.stateNames(state.figure);
    if (names.indexOf(state.mood) < 0) state.mood = 'neutral';

    var selRow = document.createElement('div');
    selRow.className = 'row';
    var sel = document.createElement('select');
    sel.className = 'sel';
    for (var i = 0; i < names.length; i++) {
      var o = document.createElement('option');
      o.value = names[i];
      o.textContent = names[i];
      sel.appendChild(o);
    }
    sel.value = state.mood;
    sel.addEventListener('change', function () { setMood(sel.value); });
    selRow.appendChild(sel);
    box.appendChild(selRow);

    var btnRow = document.createElement('div');
    btnRow.className = 'row';
    var newBtn = document.createElement('button');
    newBtn.type = 'button'; newBtn.className = 'btn'; newBtn.textContent = 'New';
    newBtn.addEventListener('click', createMood);
    var renBtn = document.createElement('button');
    renBtn.type = 'button'; renBtn.className = 'btn'; renBtn.textContent = 'Rename';
    renBtn.disabled = (state.mood === 'neutral');
    renBtn.addEventListener('click', renameMood);
    var delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'btn'; delBtn.textContent = 'Delete';
    delBtn.disabled = (state.mood === 'neutral');
    delBtn.addEventListener('click', deleteMood);
    btnRow.appendChild(newBtn);
    btnRow.appendChild(renBtn);
    btnRow.appendChild(delBtn);
    box.appendChild(btnRow);

    var out = document.createElement('p');
    out.id = 'moodOut';
    out.className = 'out';
    box.appendChild(out);

    if (state.mood !== 'neutral') {
      box.appendChild(hintLine('Editing "' + state.mood + '". Offset, tilt, hidden, '
        + 'the picture and motion parameters below write into this mood only. '
        + 'Pivot, parent, depth, role, blend, lag, opacity, alt and the rig '
        + 'itself stay locked - every mood shares one rig.'));
    }

    var problems = Idle.checkStates(state.figure);
    if (problems.length) {
      var pre = document.createElement('pre');
      pre.className = 'events';
      pre.textContent = problems.join('\n');
      box.appendChild(pre);
    }
  }

  /* Small building blocks the Layer and Motion cards share for mood editing:
   * a lock for a fixed field, and a reset button for an overridden one. */
  var LOCK_HINT = 'Shared by every mood - switch to neutral to change this.';

  function lockRow(row) {
    var ctl = row.querySelector('select, input, textarea, button');
    if (ctl) ctl.disabled = true;
    row.classList.add('locked');
    row.title = LOCK_HINT;
    return row;
  }

  function resetBtn(layerId, group, key, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'reset';
    b.textContent = '↺';
    b.title = 'Reset ' + label + ' to the neutral value';
    b.addEventListener('click', function () {
      clearOverride(layerId, group, key);
      refreshStill();
      buildMoodCard();
      buildLayerCard();
      buildMotionControls();
    });
    return b;
  }

  function withReset(row, show, layerId, group, key, label) {
    if (show) {
      row.classList.add('withReset');
      row.appendChild(resetBtn(layerId, group, key, label));
    }
    return row;
  }

  /* A number field on the same grid a slider or a picker uses, for tilt -
   * degrees, signed, no natural slider range the way strength or period
   * have one. */
  function numberField(label, value, step, onChange, onSettle) {
    var row = document.createElement('label');
    row.className = 'field';
    var t = document.createElement('span');
    t.textContent = label;
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'txt';
    inp.step = String(step);
    inp.value = String(value);
    inp.addEventListener('input', function () {
      var v = parseFloat(inp.value);
      if (isFinite(v)) onChange(v);
    });
    if (onSettle) inp.addEventListener('change', onSettle);
    row.appendChild(t);
    row.appendChild(inp);
    return row;
  }

  function checkField(label, checked, onChange) {
    var row = document.createElement('label');
    row.className = 'field';
    var t = document.createElement('span');
    t.textContent = label;
    var inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = !!checked;
    inp.addEventListener('change', function () { onChange(inp.checked); });
    row.appendChild(t);
    row.appendChild(inp);
    return row;
  }
  /* end of mood editing helpers */

  /* ================================================================== *
   * Layer properties
   *
   * The five fields that used to need a text editor: what a layer hangs
   * from, what part it plays in a blink, how it composites, how opaque it
   * starts, and what it is called for a reader that cannot see it.
   * ================================================================== */

  /* The blend modes that mean the same thing in the page and in the contact
   * sheet. `plus-darker` is deliberately absent: canvas has no equivalent, so
   * it is the one value that would make the sheet lie about what ships.
   * `normal` is first and stands for "no blend" - picking it drops the field
   * rather than writing a default nobody needs to read. */
  var BLENDS = ['normal', 'screen', 'multiply', 'overlay',
                'darken', 'lighten', 'difference', 'plus-lighter'];

  var ROLES = ['eyesOpen', 'eyesClosed'];

  function grp(title, sub) {
    var g = document.createElement('div');
    g.className = 'grp';
    var h = document.createElement('h3');
    h.textContent = title;
    if (sub) {
      var s = document.createElement('span');
      s.textContent = '  ' + sub;
      h.appendChild(s);
    }
    g.appendChild(h);
    return g;
  }

  function hintLine(text) {
    var p = document.createElement('p');
    p.className = 'hint tight';
    p.textContent = text;
    return p;
  }

  /* Two clicks rather than a dialog, for anything that deletes something. A
   * dialog is not used because window.confirm is blocked outright in some
   * embedded browsers, and a button that says what it is about to do reads
   * better than one that opens a box asking the same question.
   *
   * `confirmText` may be a function, so the second label can name the exact
   * thing about to go - a fixed HTML button and one created fresh per layer
   * both call this the same way. */
  function armDangerButton(btn, calmText, confirmText, action) {
    var timer = 0;
    function calm() {
      timer = 0;
      btn.classList.add('ghost');
      btn.textContent = calmText;
    }
    /* Only the two classes this owns. 'btn' and layout classes like 'wide'
     * differ by where the button lives - a topbar button already has its
     * base class from the markup, a per-layer one is built fresh in JS. */
    btn.classList.add('danger');
    calm();
    btn.addEventListener('click', function () {
      if (!timer) {
        btn.classList.remove('ghost');
        btn.textContent = typeof confirmText === 'function' ? confirmText() : confirmText;
        timer = window.setTimeout(calm, 4000);
        return;
      }
      window.clearTimeout(timer);
      calm();
      action();
    });
  }

  /* A labelled dropdown on the same grid as a slider, so the panel reads as
   * one column of fields rather than two kinds of control. `empty` adds a
   * leading entry that stands for "not set"; pass null to leave it out. */
  function picker(label, value, options, empty, onChange) {
    var row = document.createElement('label');
    row.className = 'field';

    var t = document.createElement('span');
    t.textContent = label;

    var sel = document.createElement('select');
    sel.className = 'sel';
    if (empty) {
      var o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = empty;
      sel.appendChild(o0);
    }
    for (var i = 0; i < options.length; i++) {
      var o = document.createElement('option');
      o.value = options[i];
      o.textContent = options[i];
      sel.appendChild(o);
    }

    /* A value the list does not offer is still a value in the file. Without
     * this the select would show blank, the field would look unset, and the
     * next touch of any control would quietly overwrite it - a figure that
     * came in with "blend": "hue" would lose it without a word. */
    if (value && options.indexOf(value) < 0) {
      var keep = document.createElement('option');
      keep.value = value;
      keep.textContent = value + '  (in the file, not offered)';
      sel.insertBefore(keep, sel.firstChild);
    }

    sel.value = value;
    sel.addEventListener('change', function () { onChange(sel.value); });

    row.appendChild(t); row.appendChild(sel);
    return row;
  }

  function textField(label, value, placeholder, onChange) {
    var row = document.createElement('label');
    row.className = 'field';

    var t = document.createElement('span');
    t.textContent = label;

    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'txt';
    inp.spellcheck = false;
    inp.value = value;
    if (placeholder) inp.placeholder = placeholder;
    inp.addEventListener('input', function () { onChange(inp.value); });

    row.appendChild(t); row.appendChild(inp);
    return row;
  }

  /* A blink is only ever visible through a role, so the two ways to write one
   * that does nothing are worth saying out loud - they cost half an hour to
   * find on the stage.
   *
   * A blink with only an `eyesClosed` layer is NOT one of them. That is the
   * normal shape for a face whose open eyes are painted into the head, which
   * is how pedro is built: the closed lids are drawn over the top and the
   * open ones need no layer of their own. */
  function blinkTrouble(fig) {
    var layers = (fig && fig.layers) || [];
    var hasBlink = false, hasRole = false;
    for (var i = 0; i < layers.length; i++) {
      var ms = layers[i].motions || [];
      for (var j = 0; j < ms.length; j++) {
        if (ms[j] && ms[j].type === 'blink') hasBlink = true;
      }
      var r = layers[i].role;
      if (r === 'eyesOpen' || r === 'eyesClosed') hasRole = true;
    }
    if (hasBlink && !hasRole) {
      return 'A blink is set, but no layer carries eyesOpen or eyesClosed. ' +
             'Nothing on the stage will change.';
    }
    if (hasRole && !hasBlink) {
      return 'A layer carries an eye role, but no layer has a blink to ' +
             'drive it. The role never fires.';
    }
    return null;
  }

  /* A layer's own tilt, defaulted like idle.js's num() does - never NaN,
   * never the string a bad hand-edit could leave behind. */
  function layerTilt(L) {
    return (typeof L.tilt === 'number' && isFinite(L.tilt)) ? L.tilt : 0;
  }

  function buildLayerCard() {
    var box = $('layerCtl');
    box.innerHTML = '';
    if (!state.figure) return;

    var L = selectedLayer();
    if (!L) {
      box.appendChild(hintLine('Pick a layer in the list above.'));
      return;
    }

    var editingMood = state.mood !== 'neutral';
    if (editingMood) {
      box.appendChild(hintLine('Editing mood "' + state.mood + '". Pivot, parent, '
        + 'depth, role, blend, lag, opacity and alt are the rig - locked here, '
        + 'shared by every mood.'));
    }

    var layers = state.figure.layers || [];
    var g = grp(L.id, L.parent ? ('child of ' + L.parent) : 'root');

    /* Everything that already hangs off this layer is left out of the list,
     * which is the whole of the ring guard: a layer can only be given a
     * parent that is not already downstream of it. */
    var blocked = descendantIds(layers, L.id);
    var free = [];
    for (var i = 0; i < layers.length; i++) {
      if (!blocked[layers[i].id]) free.push(layers[i].id);
    }
    var parentRow = picker('parent', L.parent || '', free, '— none (root) —',
      function (v) {
        if (v) L.parent = v; else delete L.parent;
        /* The engine reads the chain out of the figure on every frame, so
         * the stage is already right. The two panels that print the chain
         * are not, and neither is this card's own heading. */
        buildLayerList();
        buildLayerCard();
        buildMotionControls();
        refreshStill();
      });
    g.appendChild(editingMood ? lockRow(parentRow) : parentRow);

    var roleRow = picker('role', L.role || '', ROLES, '— none —',
      function (v) {
        if (v) L.role = v; else delete L.role;
        buildLayerList();
        buildLayerCard();
        refreshStill();
      });
    g.appendChild(editingMood ? lockRow(roleRow) : roleRow);

    var blendRow = picker('blend', L.blend || 'normal', BLENDS, null,
      function (v) {
        if (v && v !== 'normal') L.blend = v; else delete L.blend;
        /* mix-blend-mode is written once, while the stage is built. Writing
         * it straight onto the node keeps a rebuild out of a dropdown. */
        var bx = boxOf(L.id);
        if (bx) bx.style.mixBlendMode = L.blend || '';
        refreshStill();
      });
    g.appendChild(editingMood ? lockRow(blendRow) : blendRow);

    /* Out of the file at 1, because that is what the engine assumes anyway
     * and a figure.json full of "opacity": 1 is noise in a diff. */
    var opacityRow = slider('opacity', L.opacity != null ? L.opacity : 1,
      function (v) {
        if (v >= 1) delete L.opacity; else L.opacity = v;
      }, 'opacity');
    g.appendChild(editingMood ? lockRow(opacityRow) : opacityRow);

    var altRow = textField('alt', L.alt || '', 'what this part is',
      function (v) {
        if (v) L.alt = v; else delete L.alt;
        /* Same story as blend: set on the <img> when the stage is built. */
        var bx = boxOf(L.id);
        if (!bx) return;
        var im = bx.getElementsByTagName('img');
        for (var k = 0; k < im.length; k++) im[k].alt = L.alt || '';
      });
    g.appendChild(editingMood ? lockRow(altRow) : altRow);

    /* tilt and hidden: plain layer fields in neutral, an override in a mood -
     * "mostly useful in a mood" per docs/figure-json.md, but a rig can carry
     * a standing one too. */
    var tiltBase = layerTilt(L);
    var tiltOv = editingMood && hasOverride(L.id, null, 'tilt');
    var tiltShown = editingMood ? overrideVal(L.id, null, 'tilt', tiltBase) : tiltBase;
    var tiltRow = numberField('tilt', tiltShown, 0.1, function (v) {
      if (editingMood) {
        if (v === tiltBase) clearOverride(L.id, null, 'tilt');
        else setOverride(L.id, null, 'tilt', v);
      } else if (v === 0) {
        delete L.tilt;
      } else {
        L.tilt = v;
      }
      refreshStill();
    }, function () { buildLayerCard(); });
    withReset(tiltRow, tiltOv, L.id, null, 'tilt', 'tilt');
    g.appendChild(tiltRow);

    var hidBase = L.hidden === true;
    var hidOv = editingMood && hasOverride(L.id, null, 'hidden');
    var hidShown = editingMood ? overrideVal(L.id, null, 'hidden', hidBase) : hidBase;
    var hidRow = checkField('hidden', hidShown, function (v) {
      if (editingMood) {
        if (v === hidBase) clearOverride(L.id, null, 'hidden');
        else setOverride(L.id, null, 'hidden', v);
      } else if (v) {
        L.hidden = true;
      } else {
        delete L.hidden;
      }
      refreshStill();
      buildLayerCard();
      buildLayerList();
    });
    withReset(hidRow, hidOv, L.id, null, 'hidden', 'hidden');
    g.appendChild(hidRow);

    /* offset has no field of its own even in neutral - it is dragged (Alt) or
     * nudged (arrow keys) on the stage. In a mood it still is, but a mood
     * also needs a way to see it and take it back, and dragging is not that,
     * so it gets a read-only line with the reset button the other overridden
     * fields have. */
    if (editingMood) {
      var offOv = hasOverride(L.id, null, 'offset');
      var offNow = effectiveOffsetOf(L);
      var offRow = document.createElement('div');
      offRow.className = 'field';
      var offLbl = document.createElement('span');
      offLbl.textContent = 'offset';
      var offVal = document.createElement('span');
      offVal.className = 'val';
      offVal.style.textAlign = 'left';
      offVal.textContent = offNow[0] + ' / ' + offNow[1] + ' px - Alt-drag or arrow keys on stage';
      offRow.appendChild(offLbl);
      offRow.appendChild(offVal);
      withReset(offRow, offOv, L.id, null, 'offset', 'offset');
      g.appendChild(offRow);

      /* The picture this mood shows for the layer. Ignored on a frames layer
       * by the engine - the flipbook picks among frames - so there is
       * nothing useful to offer there. */
      if (!(L.frames && L.frames.length)) {
        var srcOv = hasOverride(L.id, null, 'src');
        var srcNow = overrideVal(L.id, null, 'src', '');
        var srcRow = document.createElement('label');
        srcRow.className = 'field';
        var srcLbl = document.createElement('span');
        srcLbl.textContent = 'picture';
        srcRow.appendChild(srcLbl);
        var srcCtl;
        if (state.hasApi) {
          srcCtl = buildSrcSelect(srcNow);
        } else {
          srcCtl = document.createElement('input');
          srcCtl.type = 'text';
          srcCtl.className = 'txt';
          srcCtl.spellcheck = false;
          srcCtl.value = srcNow;
          srcCtl.placeholder = 'layers/....webp - blank means the neutral picture';
        }
        (function (ctl) {
          function apply() { onMoodSrcChange(L, ctl.value); }
          ctl.addEventListener('change', apply);
        })(srcCtl);
        srcRow.appendChild(srcCtl);
        withReset(srcRow, srcOv, L.id, null, 'src', 'picture');
        g.appendChild(srcRow);
      }
    }

    box.appendChild(g);

    var msg = blinkTrouble(state.figure);
    if (msg) box.appendChild(hintLine(msg));

    if ((state.figure.layers || []).length > 1) {
      if (editingMood) {
        box.appendChild(hintLine('Remove this layer: locked while editing a mood - '
          + 'layers are the rig, shared by every mood.'));
      } else {
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn wide';
        armDangerButton(del, 'Remove this layer',
          function () { return 'Really remove "' + L.id + '" and its image?'; },
          function () { removeLayer(L); });
        box.appendChild(del);
        box.appendChild(hintLine('This deletes the layer’s image from the '
          + 'figure folder as well. Leaving the file behind would put the layer '
          + 'back on the next cut or upload.'));
      }
    }
  }

  /* A select of the figure's own layer files, prefixed the way figure.json
   * paths always are ("layers/..."), plus "(neutral picture)" for no
   * override. Used only when tools/serve.py answers /_files - a plain
   * `python -m http.server` gets a text input instead, in buildLayerCard. */
  function buildSrcSelect(current) {
    var sel = document.createElement('select');
    sel.className = 'sel';
    var o0 = document.createElement('option');
    o0.value = '';
    o0.textContent = '(neutral picture)';
    sel.appendChild(o0);
    var files = state.srcOptions || [];
    for (var i = 0; i < files.length; i++) {
      var o = document.createElement('option');
      o.value = files[i];
      o.textContent = files[i];
      sel.appendChild(o);
    }
    if (current && files.indexOf(current) < 0) {
      var keep = document.createElement('option');
      keep.value = current;
      keep.textContent = current + '  (in the file, not listed)';
      sel.insertBefore(keep, sel.children[1] || null);
    }
    sel.value = current || '';
    return sel;
  }

  /* Every file figures/<name>/layers/ holds right now, for the mood picture
   * select. Refreshed whenever a figure mounts; a figure with no write
   * server (state.hasApi false) falls back to a text field instead, so this
   * is left null there rather than fetched and silently ignored. */
  function refreshSrcOptions() {
    if (!state.hasApi || !state.name) { state.srcOptions = null; return Promise.resolve(); }
    return figureFiles(state.name).then(function (d) {
      state.srcOptions = (d.layers || []).map(function (f) { return 'layers/' + f; });
      buildLayerCard();
    });
  }

  /* A mood picture only ever shows once the figure it belongs to has an <img>
   * for it (the DOM) and an entry in the image bank (the canvas work) - both
   * built once, at mount, from every state src a layer can show. A src typed
   * or picked here after that has neither, so both have to be rebuilt: the
   * stage remounts (imagesOf() sees the new override and gets its <img> this
   * time) and the image bank reloads the same way mounting a figure does. */
  function onMoodSrcChange(L, val) {
    var v = (val || '').trim();
    if (!v) clearOverride(L.id, null, 'src');
    else setOverride(L.id, null, 'src', v);
    /* A crop belongs to the src it was cut for - the studio's Export writes
     * one, by hand there is none - so a picture typed in here always shows
     * at full canvas, and any crop left over from a different picture would
     * be wrong for this one. */
    clearOverride(L.id, null, 'crop');
    rebuildStage();
    buildLayerCard();
    var mine = ++imageLoads;
    state.images = null;
    Idle.loadImages(state.figure, state.base)
      .then(function (imgs) { if (mine === imageLoads) state.images = imgs; })
      .catch(function (e) { say(String((e && e.message) || e)); });
  }

  /* ------------------------------------------------------------------ *
   * Removing a layer
   *
   * Taking the entry out of figure.json is not enough. The picture it came
   * from is still in the folder, and import-layers.py adds a part it does
   * not recognise as a new layer - so the next cut or upload would put the
   * layer straight back. Both files go, or neither does.
   * ------------------------------------------------------------------ */

  function deleteFile(path) {
    return fetch(path, { method: 'DELETE' }).then(function (r) {
      /* 404 is a fine outcome here: it means the file was already gone. */
      if (!r.ok && r.status !== 404) {
        return r.text().then(function (t) { throw new Error(t); });
      }
    });
  }

  /* What is actually in a figure's folder.
   *
   * Deliberately not the directory listing. On this machine the HTML listing
   * for a folder of twelve files arrives cut off after six, mid-tag, with a
   * Content-Length that matches the truncated body - under a plain
   * `python -m http.server` as well, so it is not something serve.py did.
   * GET /_files answers from os.listdir and is right. */
  function figureFiles(name) {
    return fetch('/_files?name=' + encodeURIComponent(name))
      .then(function (r) { return r.ok ? r.json() : { files: [], layers: [] }; })
      .catch(function () { return { files: [], layers: [] }; });
  }

  /* The part name a file name carries, by the same rule import-layers.py
   * uses: drop a leading number, then the figure's own name. */
  function partOfFile(fname, figure) {
    var stem = fname.replace(/\.[^.]+$/, '');
    while (stem && stem[0] >= '0' && stem[0] <= '9') stem = stem.slice(1);
    stem = stem.replace(/^[-_. ]+/, '');
    if (stem.toLowerCase().indexOf(figure.toLowerCase()) === 0) {
      stem = stem.slice(figure.length).replace(/^[-_. ]+/, '');
    }
    return slugLike(stem);
  }

  /* The numbered file a cut or an upload left in the figure folder, whose
   * name folds onto this layer's id. */
  function sourceFileFor(name, id) {
    return figureFiles(name).then(function (d) {
      var out = [];
      for (var i = 0; i < d.files.length; i++) {
        var f = d.files[i];
        if (!/\.(png|webp|jpe?g)$/i.test(f)) continue;
        if (f === 'source.png' || f === 'marks.png') continue;
        if (partOfFile(f, name) === id) out.push(f);
      }
      return out;
    });
  }

  function removeLayer(L) {
    var name = state.name;
    var layers = state.figure.layers || [];
    var i = layers.indexOf(L);
    if (i < 0) return;

    /* Whatever hung off it now hangs off what it hung off. Leaving a child
     * pointing at a layer that is gone is the one broken state the engine
     * cannot survive - it walks the chain on every frame. */
    for (var k = 0; k < layers.length; k++) {
      if (layers[k].parent === L.id) {
        if (L.parent) layers[k].parent = L.parent;
        else delete layers[k].parent;
      }
    }
    layers.splice(i, 1);
    if (state.selected === L.id) state.selected = null;

    rebuildStage();
    buildLayerList();
    buildLayerCard();
    buildMotionControls();

    if (!state.canWrite || !onDisk()) {
      say('Removed "' + L.id + '" from the figure. Nothing was deleted from '
        + 'disk - this server cannot write.');
      return;
    }

    /* The image files go next. Undo past this point would bring back a
     * layer that points at nothing, so the history starts over here. */
    resetHistory();

    say('removing ' + L.id + ' …');
    sourceFileFor(name, L.id)
      .then(function (files) {
        var jobs = [deleteFile(FIGURES_ROOT + name + '/' + L.src)];
        for (var j = 0; j < files.length; j++) {
          jobs.push(deleteFile(FIGURES_ROOT + name + '/' + files[j]));
        }
        return Promise.all(jobs).then(function () { return files; });
      })
      .then(function (files) {
        return saveFigure().then(function () {
          say('Removed "' + L.id + '" and ' + (1 + files.length) +
              ' image file' + (files.length ? 's' : '') + '.');
        });
      })
      .catch(function (e) { say(String((e && e.message) || e)); });
  }

  /* Rebuild the stage from the figure object as it stands now.
   *
   * Three things are decided once, while the DOM goes up, and never again:
   * mix-blend-mode, the alt text, and whether a layer gets a `filter` at all.
   * The last one is the trap - `lit` is true only for a layer that already
   * carried a glow or a charge at build time, so a glow added from the panel
   * wrote its brightness into a node that ignores it. The panel said one
   * thing and the stage showed another, which is exactly the failure this
   * whole card exists to remove.
   *
   * Blend and alt are cheap enough to write straight onto the nodes. A change
   * to the motion list is not, so it comes through here.
   *
   * Time, play state, pointer and the eye toggles survive. The dirty mark
   * deliberately does not move: nothing here has been near the disk. */
  function rebuildStage() {
    if (!state.fig) return;
    var t = state.fig.time;
    var wasPlaying = state.fig.playing;
    var px = state.fig.pointerX, py = state.fig.pointerY;

    state.fig.destroy();
    state.fig = new Idle.IdleFigure($('stage'), state.figure, state.base,
                                    { background: false });
    state.fig.loop = $('loopWindow').checked ? state.window : 0;
    state.fig.pointerX = px;
    state.fig.pointerY = py;
    state.fig.time = t;
    applyHidden();
    /* The constructor always mounts at neutral - put back whichever mood the
     * panel is showing, or a rebuild (a parent change, a motion added, a
     * layer removed) would silently drop back to neutral on screen. */
    applyMoodToFig();
    if (wasPlaying) state.fig.play(); else state.fig.render(t);
    /* The constructor fits the new stage and writes its own transform, so
     * the zoom and pan have to be put back on top of it. */
    applyView();
    drawOverlay();
  }

  /* ================================================================== *
   * Motion controls
   * ================================================================== */

  /* Sensible ranges per parameter. Anything not listed gets a generic range,
   * so a new motion type still gets usable sliders on day one. */
  var RANGES = {
    strength:   [0, 3, 0.01],
    period:     [0.3, 20, 0.05],
    degrees:    [0, 20, 0.1],
    phase:      [0, 1, 0.01],
    pixels:     [0, 60, 0.5],
    follow:     [0, 2, 0.01],
    interval:   [0.5, 15, 0.1],
    duration:   [0.03, 1, 0.01],
    fps:        [1, 30, 1],
    every:      [0.5, 30, 0.1],
    jitter:     [0, 1, 0.01],
    min:        [0, 1, 0.01],
    brightness: [0, 2, 0.01],
    parallax:   [0, 2, 0.01],
    depth:      [0, 1, 0.01],
    lag:        [0, 1, 0.005],
    stages:     [1, 6, 1],
    cycle:      [2, 60, 0.5],
    hold:       [0.05, 4, 0.05],
    ramp:       [0.05, 3, 0.05],
    showFrom:   [1, 6, 1],
    grow:       [0, 0.3, 0.005],
    /* drift travels somewhere and stays, so its numbers are the only ones
     * here that are not small and positive. They were missing entirely, and
     * the generic 0..10 fallback then drew a slider that could not reach the
     * default dy of -120 - a block you could add but not steer. */
    dx:         [-300, 300, 1],
    dy:         [-300, 300, 1],
    life:       [0.3, 12, 0.05],
    wander:     [0, 40, 0.5],
    opacity:    [0, 1, 0.01]
  };

  /* onSettle: an optional extra callback for the drag's end (the 'change'
   * event, not 'input'). Mood editing needs it to refresh a reset button
   * that only appears once an override exists - rebuilding the whole card on
   * every 'input' would pull the slider out from under a drag in progress. */
  function slider(label, value, onChange, key, onSettle) {
    var r = RANGES[key] || [0, 10, 0.01];
    var row = document.createElement('label');
    row.className = 'slider';

    var t = document.createElement('span');
    t.textContent = label;

    var inp = document.createElement('input');
    inp.type = 'range';
    inp.min = String(r[0]); inp.max = String(r[1]); inp.step = String(r[2]);
    inp.value = String(value);

    var out = document.createElement('span');
    out.className = 'val';
    out.textContent = fmt(value);

    inp.addEventListener('input', function () {
      var v = parseFloat(inp.value);
      out.textContent = fmt(v);
      onChange(v);
      refreshStill();
    });
    if (onSettle) inp.addEventListener('change', onSettle);

    row.appendChild(t); row.appendChild(inp); row.appendChild(out);
    return row;
  }

  function fmt(v) {
    return (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  }

  /* Every parameter each block actually reads, with the engine's default.
   *
   * The studio used to draw a slider only for keys already present in the
   * JSON, so a motion written without `period` ran on the default with no
   * control anywhere to find it. These values are copied from MOTIONS in
   * idle.js and are checked against it by tools/test-agreement.mjs. */
  var MOTION_PARAMS = {
    breathe:  { strength: 1, period: 4.0, phase: 0 },
    sway:     { strength: 1, period: 7.5, degrees: 2.2, phase: 0 },
    blink:    { interval: 4.2, duration: 0.13 },
    gaze:     { strength: 1, pixels: 9, degrees: 1.4, follow: 1, period: 11.3 },
    flipbook: { fps: 12, every: 6.5, jitter: 0.45 },
    glow:     { strength: 1, period: 5.3, min: 0.55, brightness: 0.22, phase: 0 },
    charge:   { stages: 3, cycle: 24, hold: 1.0, ramp: 0.35, showFrom: 1,
                brightness: 0.6, grow: 0.02 },
    drift:    { dx: 0, dy: -120, life: 3.0, every: 4.0, jitter: 0.5,
                phase: 0, wander: 6 }
  };

  function buildMotionControls() {
    var box = $('motionCtl');
    box.innerHTML = '';
    var L = selectedLayer();
    if (!L) {
      var p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Pick a layer to see its motion.';
      box.appendChild(p);
      return;
    }

    var editingMood = state.mood !== 'neutral';
    if (editingMood) {
      box.appendChild(hintLine('Editing mood "' + state.mood + '". Motion '
        + 'parameters below write into this mood; depth, extra lag and '
        + 'whole motion blocks are the rig - locked here.'));
    }

    /* Layer-level values first: how deep it sits, how far it lags. Neither
     * is an override key a mood may carry - both are the rig. */
    var g0 = document.createElement('div');
    g0.className = 'grp';
    var h0 = document.createElement('h3');
    h0.textContent = L.id;
    var sp = document.createElement('span');
    sp.textContent = L.parent ? ('  child of ' + L.parent) : '  root';
    h0.appendChild(sp);
    g0.appendChild(h0);
    var depthRow = slider('depth', L.depth != null ? L.depth : 0,
      function (v) { L.depth = v; }, 'depth');
    g0.appendChild(editingMood ? lockRow(depthRow) : depthRow);
    var lagRow = slider('extra lag', L.lag || 0,
      function (v) { L.lag = v; }, 'lag');
    g0.appendChild(editingMood ? lockRow(lagRow) : lagRow);
    box.appendChild(g0);

    var ms = L.motions || [];
    for (var i = 0; i < ms.length; i++) {
      (function (m, mi) {
        var g = document.createElement('div');
        g.className = 'grp';
        var h = document.createElement('h3');
        h.textContent = m.type;

        var kill = document.createElement('button');
        kill.type = 'button';
        kill.className = 'x';
        kill.textContent = '×';
        kill.title = editingMood ? LOCK_HINT : 'remove this motion';
        kill.disabled = editingMood;
        kill.addEventListener('click', function () {
          ms.splice(mi, 1);
          /* An empty motions array is the same as none, and the shorter of
           * the two is what belongs in the file. */
          if (!ms.length) delete L.motions;
          rebuildStage();
          buildLayerList();
          /* The card carries the blink advice, and that reading just
           * changed. */
          buildLayerCard();
          buildMotionControls();
        });
        h.appendChild(kill);
        g.appendChild(h);

        /* loop or burst, and fade or hard cut: words, not numbers, kept out
         * of MOTION_PARAMS on purpose (see the comments below) - but both are
         * still parameters of the motion they sit on, so a mood may override
         * either exactly like a numeric one. */
        if (m.type === 'flipbook') {
          var modeBase = m.mode || 'burst';
          var modeOv = editingMood && hasOverride(L.id, m.type, 'mode');
          var modeShown = editingMood ? overrideVal(L.id, m.type, 'mode', modeBase) : modeBase;
          var modeRow = picker('mode', modeShown, ['loop', 'burst'], null, function (v) {
            if (editingMood) {
              if (v === modeBase) clearOverride(L.id, m.type, 'mode');
              else setOverride(L.id, m.type, 'mode', v);
              buildMotionControls();
            } else {
              m.mode = v;
            }
            refreshStill();
          });
          withReset(modeRow, modeOv, L.id, m.type, 'mode', 'mode');
          g.appendChild(modeRow);
        }

        /* Only flipbook. charge reads no frames at all - it drives opacity,
         * and a layer with a single image goes dark between flashes exactly
         * as it should. */
        if (m.type === 'flipbook' && !(L.frames && L.frames.length)) {
          g.appendChild(hintLine('This layer has one image, not frames, so ' +
            'a flipbook has nothing to switch between.'));
        }

        /* fade out, or cut hard the instant life ends. Kept out of
         * MOTION_PARAMS for the same reason as flipbook's mode: this is a
         * word, not a number, and the agreement test excludes it the same
         * way. */
        if (m.type === 'drift') {
          var fadeBase = m.fadeOut === false ? 'hard cut' : 'fade out';
          var fadeOv = editingMood && hasOverride(L.id, m.type, 'fadeOut');
          var fadeBool = editingMood ? overrideVal(L.id, m.type, 'fadeOut', m.fadeOut !== false) : (m.fadeOut !== false);
          var fadeShown = fadeBool ? 'fade out' : 'hard cut';
          var fadeRow = picker('fade', fadeShown, ['fade out', 'hard cut'], null, function (v) {
            if (editingMood) {
              var vb = (v !== 'hard cut');
              if (vb === (m.fadeOut !== false)) clearOverride(L.id, m.type, 'fadeOut');
              else setOverride(L.id, m.type, 'fadeOut', vb);
              buildMotionControls();
            } else {
              m.fadeOut = (v !== 'hard cut');
            }
            refreshStill();
          });
          withReset(fadeRow, fadeOv, L.id, m.type, 'fadeOut', 'fade');
          g.appendChild(fadeRow);
        }

        var known = MOTION_PARAMS[m.type] || {};
        var keys = [], seen = {};
        for (var k in known) {
          if (Object.prototype.hasOwnProperty.call(known, k)) { keys.push(k); seen[k] = 1; }
        }
        /* Anything the JSON carries that the block does not read still gets a
         * slider, but labelled, so a "strength" on blink cannot look real. */
        for (k in m) {
          if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
          if (k === 'type' || k === 'mode' || seen[k]) continue;
          if (typeof m[k] === 'number') keys.push(k);
        }

        for (var q = 0; q < keys.length; q++) {
          (function (key) {
            var isRead = Object.prototype.hasOwnProperty.call(known, key);
            var base = (typeof m[key] === 'number') ? m[key] : known[key];
            var label = isRead ? key : key + ' (ignored)';
            var ov = editingMood && hasOverride(L.id, m.type, key);
            var shown = editingMood ? overrideVal(L.id, m.type, key, base) : base;
            var row = slider(label, shown, function (v) {
              if (editingMood) {
                if (v === base) clearOverride(L.id, m.type, key);
                else setOverride(L.id, m.type, key, v);
              } else {
                m[key] = v;
              }
            }, key, editingMood ? function () { buildMotionControls(); } : null);
            withReset(row, ov, L.id, m.type, key, key);
            g.appendChild(row);
          })(keys[q]);
        }
        box.appendChild(g);
      })(ms[i], i);
    }

    /* Filled by updatePeriodWarning(), which refreshStill() calls on every
     * slider step - rebuilding the card there would drop the slider out from
     * under the pointer. */
    var clash = document.createElement('p');
    clash.id = 'periodWarn';
    clash.className = 'hint tight clash';
    box.appendChild(clash);
    updatePeriodWarning();

    /* Add a block. Only the types this layer does not carry yet: two blinks
     * on one layer read the same clock and fire as one event, and two drifts
     * make the layer jump between two rises, which is the flicker the
     * agreement test already refuses. Locked while editing a mood - a mood
     * changes a motion's numbers, it never adds or removes a whole block. */
    var used = {}, key;
    for (i = 0; i < ms.length; i++) used[ms[i].type] = true;
    var spare = [];
    for (key in MOTION_PARAMS) {
      if (Object.prototype.hasOwnProperty.call(MOTION_PARAMS, key) &&
          !used[key]) spare.push(key);
    }

    var ga = document.createElement('div');
    ga.className = 'grp';
    var row = document.createElement('div');
    row.className = 'row';

    var pick = document.createElement('select');
    pick.className = 'sel small';
    for (i = 0; i < spare.length; i++) {
      var op = document.createElement('option');
      op.value = spare[i];
      op.textContent = spare[i];
      pick.appendChild(op);
    }

    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn';
    add.textContent = 'Add motion';

    if (!spare.length) {
      var none = document.createElement('option');
      none.textContent = 'all eight are on this layer';
      pick.appendChild(none);
      pick.disabled = true;
      add.disabled = true;
    }
    if (editingMood) {
      pick.disabled = true;
      add.disabled = true;
      pick.title = add.title = LOCK_HINT;
    }

    add.addEventListener('click', function () {
      var type = pick.value;
      if (!type || !MOTION_PARAMS[type]) return;
      /* Every number the engine reads, written out at its own default, so
       * the block arrives with a full set of sliders rather than a handful
       * and some invisible defaults behind them. */
      var m = { type: type };
      var d = MOTION_PARAMS[type];
      for (var k in d) {
        if (Object.prototype.hasOwnProperty.call(d, k)) m[k] = d[k];
      }
      if (type === 'flipbook') m.mode = 'burst';
      if (!L.motions) L.motions = [];
      L.motions.push(m);
      rebuildStage();
      buildLayerList();
      buildLayerCard();
      buildMotionControls();
    });

    row.appendChild(pick);
    row.appendChild(add);
    ga.appendChild(row);
    box.appendChild(ga);

    /* Whole-figure values live at the bottom, where they cannot be mistaken
     * for something that belongs to the selected layer. */
    var gf = document.createElement('div');
    gf.className = 'grp';
    var hf = document.createElement('h3');
    hf.textContent = 'figure';
    gf.appendChild(hf);
    var mo = state.figure.motion || (state.figure.motion = {});
    gf.appendChild(slider('parallax', mo.parallax != null ? mo.parallax : 0.35,
      function (v) { mo.parallax = v; }, 'parallax'));
    gf.appendChild(slider('follow lag', mo.followSeconds != null ? mo.followSeconds : 0.085,
      function (v) { mo.followSeconds = v; }, 'lag'));
    box.appendChild(gf);
  }

  function refreshStill() {
    if (state.fig && !state.fig.playing) state.fig.render(state.fig.time);
    drawOverlay();
    updatePeriodWarning();
  }

  /* period clash check */
  /* Two parts on one period move as one mechanism: their peaks keep the same
   * distance forever, so the eye reads a single pulse instead of two things
   * alive. The same goes for an exact double - 4.0 against 8.0 locks, 4.0
   * against 7.5 does not (principle 8, figure-json.md "Three rules").
   *
   * Every motion that has a `period` counts, on any layer, whatever its type:
   * a chest breathing at 4.0 and a cloak swaying at 4.0 lock just the same.
   * A missing or unusable period is the engine's default, because that is
   * what runs. A block at strength 0 does not move and does not count.
   *
   * gaze against gaze is left out. Its period is the idle wander of the
   * look, and two pupils - or a head and the eyes in it - are meant to look
   * the same way at the same time. Pedro's pupils share 9.7 s on purpose.
   *
   * Pure on purpose, and handed the defaults rather than reading
   * MOTION_PARAMS, so tools/test-agreement.mjs can lift it out and run it. */
  function periodClashes(figure, layerId, params) {
    var layers = (figure && figure.layers) || [];
    var all = [], mine = [];
    for (var i = 0; i < layers.length; i++) {
      var ms = (layers[i] && layers[i].motions) || [];
      for (var j = 0; j < ms.length; j++) {
        var m = ms[j];
        var d = m && params[m.type];
        if (!d || !Object.prototype.hasOwnProperty.call(d, 'period')) continue;
        if (m.strength === 0) continue;
        var p = (typeof m.period === 'number' && m.period > 0) ? m.period : d.period;
        var e = { id: layers[i].id, type: m.type, period: p, n: all.length };
        all.push(e);
        if (layers[i].id === layerId) mine.push(e);
      }
    }
    var out = [], seen = {};
    for (i = 0; i < mine.length; i++) {
      for (j = 0; j < all.length; j++) {
        var a = mine[i], b = all[j];
        if (a.n === b.n) continue;
        if (a.type === 'gaze' && b.type === 'gaze') continue;
        var r = Math.max(a.period, b.period) / Math.min(a.period, b.period);
        /* Within 1 %. The Kriegerin's apron fibres step 5.5, 5.9, 6.1, 6.4
         * on purpose so they fan out; 2 % flagged half of them. 6.8 against
         * 6.85 is still caught - that pair drifts apart once in 15 minutes. */
        var kind = r < 1.01 ? 'same' : (Math.abs(r - 2) < 0.02 ? 'double' : null);
        /* Two blocks on the selected layer meet twice, once from each side.
         * One pair, one mention. */
        var key = b.id === layerId
          ? kind + '|own|' + Math.min(a.n, b.n) + '|' + Math.max(a.n, b.n)
          : kind + '|' + b.id + '|' + b.type;
        if (!kind || seen[key]) continue;
        seen[key] = 1;
        out.push({ kind: kind, id: b.id, type: b.type, period: b.period,
                   own: b.id === layerId });
      }
    }
    return out;
  }
  /* end of the period clash check */

  function updatePeriodWarning() {
    var el = $('periodWarn');
    if (!el) return;
    var list = state.figure
      ? periodClashes(state.figure, state.selected, MOTION_PARAMS) : [];
    function names(kind) {
      var hit = list.filter(function (c) { return c.kind === kind; });
      var shown = hit.slice(0, 3).map(function (c) {
        /* Two decimals, one trailing zero dropped: 7.5, 4.0, 6.85. A plain
         * toFixed(1) printed 6.85 as "6.8" and the pair looked identical. */
        return (c.own ? 'its own ' : c.id + ' ') + '(' + c.type + ' ' +
               c.period.toFixed(2).replace(/0$/, '') + ' s)';
      });
      if (hit.length > 3) shown.push('+' + (hit.length - 3) + ' more');
      return shown.join(', ');
    }
    var lines = [];
    var same = names('same'), dbl = names('double');
    if (same) lines.push('Same period as ' + same + ' - they move in step.');
    if (dbl) lines.push('Double or half the period of ' + dbl + ' - they lock together.');
    el.textContent = lines.join(' ');
    el.hidden = !lines.length;
  }

  /* ================================================================== *
   * Transport
   * ================================================================== */

  /* Read-only. The player owns the clock, including the window loop - the
   * studio must never stop and restart it from the outside. */
  function tick() {
    if (state.fig) {
      var t = state.fig.time;
      $('timeOut').textContent = t.toFixed(2) + ' s';
      if (state.fig.playing) {
        $('scrub').value = String(Math.min(t, state.window));
      }
      if (overlayDirty) { overlayDirty = false; paintOverlay(); }
    }
    requestAnimationFrame(tick);
  }

  /* ================================================================== *
   * Pivot overlay - click a dot, drag it, the JSON follows
   * ================================================================== */

  function sizeOverlay() {
    var c = $('overlay');
    var r = c.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
  }

  /* ------------------------------------------------------------------ *
   * The view: a magnifying glass over the stage
   *
   * `zoom` 1 means the whole figure fits, which is where every figure
   * starts. Above that you are closer than the frame; the pan then says
   * which part of it you are looking at, in screen pixels.
   *
   * None of this is part of the figure. The contact sheet, the events scan,
   * the export and the IoU test all render from the figure data at a fixed
   * size, so nothing here can reach them - a magnifying glass, not a scale.
   * ------------------------------------------------------------------ */

  var view = { zoom: 1, panX: 0, panY: 0 };
  var ZOOM_MIN = 0.25;
  var ZOOM_MAX = 12;

  /* One description of where the figure sits, for everything that needs it.
   * The two conversions below used to carry a copy of this each, which is
   * two chances for them to disagree about the same pixel. */
  function viewMap() {
    var r = $('stage').getBoundingClientRect();
    var f = state.figure;
    var w = (f && f.size && f.size.width) || 1000;
    var h = (f && f.size && f.size.height) || 1000;
    var fit = Math.min(r.width / w, r.height / h);
    return {
      w: w, h: h,
      rw: r.width, rh: r.height,
      fit: fit,
      k: fit * view.zoom,
      cx: r.width / 2 + view.panX,
      cy: r.height / 2 + view.panY,
      dpr: window.devicePixelRatio || 1
    };
  }

  /* The same projection as stageToOverlay, against a map you already have.
   * drawOverlay runs on every frame and once per layer, and each call to
   * viewMap() reads a bounding rect - 35 forced layouts a frame on pedro. */
  function project(m, px, py) {
    return [
      (m.cx + (px - m.w / 2) * m.k) * m.dpr,
      (m.cy + (py - m.h / 2) * m.k) * m.dpr
    ];
  }

  /* Stage pixel (0..w, 0..h) to overlay pixel. */
  function stageToOverlay(px, py) {
    return project(viewMap(), px, py);
  }

  function overlayToStage(cx, cy) {
    var m = viewMap();
    return [
      (cx / m.dpr - m.cx) / m.k + m.w / 2,
      (cy / m.dpr - m.cy) / m.k + m.h / 2
    ];
  }

  /* The player fits the figure to the host and writes that as a transform.
   * The pan and the zoom ride on top of it, written here rather than there:
   * how close someone is looking is a property of this page, not of the
   * character, and idle.js ships to targets that have no viewport at all.
   *
   * The pan sits before the scale on purpose. A translate that comes first
   * in the list is applied last, so it moves the figure by screen pixels -
   * dragging 120 px moves it 120 px whatever the zoom is. */
  function applyView() {
    if (!state.fig || !state.fig.stage) return;
    var m = viewMap();
    state.fig.stage.style.transform =
      'translate(-50%, -50%) translate(' +
      view.panX.toFixed(2) + 'px, ' + view.panY.toFixed(2) + 'px) scale(' +
      m.k.toFixed(5) + ')';
    /* The mask rides the same transform as the stage. That is the whole
     * reason it can be painted in figure pixels: what is under the brush on
     * screen is under the brush in the file. */
    var mc = $('marks');
    if (mc && !mc.hidden) mc.style.transform = state.fig.stage.style.transform;
    var pc = $('place');
    if (pc && !pc.hidden) pc.style.transform = state.fig.stage.style.transform;

    var out = $('zoomOut');
    if (out) out.textContent = Math.round(view.zoom * 100) + ' %';
  }

  /* Everything that changes how much room the stage has ends here: the
   * window, a rail folding, a rail being dragged, a figure being mounted.
   * fit() alone would throw the zoom away, because it writes the whole
   * transform itself. */
  function refitStage() {
    if (state.fig) state.fig.fit();
    applyView();
    sizeOverlay();
    drawOverlay();
  }

  function panBy(dx, dy) {
    view.panX += dx;
    view.panY += dy;
    applyView();
    drawOverlay();
  }

  function resetView() {
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    applyView();
    drawOverlay();
  }

  /* Zoom about a point, so the thing under the pointer stays under it. The
   * alternative is zooming about the middle, which walks whatever you were
   * looking at off the edge after two notches. */
  function zoomAt(next, cx, cy) {
    next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    if (next === view.zoom) return;

    var before = overlayToStage(cx, cy);
    view.zoom = next;

    var m = viewMap();
    view.panX = cx / m.dpr - m.rw / 2 - (before[0] - m.w / 2) * m.k;
    view.panY = cy / m.dpr - m.rh / 2 - (before[1] - m.h / 2) * m.k;

    applyView();
    drawOverlay();
  }

  /* The pivot dots are drawn from the figure, not from the animation: a
   * swaying head moves, the dot marking its neck does not. So the overlay
   * only has to be repainted when the figure, the selection or the view
   * changes - and everything that changes one of those already calls
   * drawOverlay().
   *
   * It used to repaint on every frame regardless. Measured on grim at a
   * device pixel ratio of 1.75 that was a 1624 x 1482 canvas, 2.4 million
   * pixels, cleared and redrawn and recomposited sixty times a second to
   * show twenty-two dots that had not moved. The script cost alone was
   * 0.40 ms of the 0.54 ms the whole frame took; the compositing cost was
   * on top of that and is what showed up as a stutter.
   *
   * A repaint one frame late is invisible, so the flag is enough. */
  var overlayDirty = true;

  function drawOverlay() { overlayDirty = true; }

  function paintOverlay() {
    var c = $('overlay');
    var g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    if (!state.figure || !$('showPivots').checked) return;

    var f = state.figure;
    var m = viewMap();
    var w = m.w, h = m.h;
    var layers = f.layers || [];

    /* Bones: a line from every joint to its parent's joint, under the dots.
     * A wrong parent shows as a line to the wrong place, and a pivot that
     * sits off its joint shows as a bone that does not follow the body.
     * The selected layer's chain up to the root is drawn bright, the rest
     * faint. Display only - nothing here writes to the figure. */
    /* No prototype: a layer called "constructor" must not find one. */
    var joint = [], parentOf = Object.create(null);
    for (var b = 0; b < layers.length; b++) {
      var pv = layers[b].pivot || [0.5, 0.5];
      joint[b] = project(m, pv[0] * w, pv[1] * h);
      /* First layer wins on a duplicate id, as the parent lookup does. */
      if (!(layers[b].id in parentOf)) parentOf[layers[b].id] = b;
    }
    /* The walk up stops at a missing parent and at a ring. */
    var lit = Object.create(null);
    for (var id = state.selected; id in parentOf && !lit[id]; id = layers[parentOf[id]].parent) {
      lit[id] = true;
    }
    g.lineCap = 'round';
    for (var pass = 0; pass < 2; pass++) {
      /* Faint first, bright on top, so a busy rig cannot hide the chain. */
      g.strokeStyle = pass ? 'rgba(110,168,254,0.85)' : 'rgba(230,233,238,0.2)';
      g.lineWidth = (pass ? 2 : 1) * m.dpr;
      g.beginPath();
      for (b = 0; b < layers.length; b++) {
        var par = layers[b].parent;
        if (!(par in parentOf) || par === layers[b].id) continue;
        if (!!lit[layers[b].id] !== !!pass) continue;
        var to = joint[parentOf[par]];
        g.moveTo(joint[b][0], joint[b][1]);
        g.lineTo(to[0], to[1]);
      }
      g.stroke();
    }

    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var p = L.pivot || [0.5, 0.5];
      var xy = project(m, p[0] * w, p[1] * h);
      var on = (L.id === state.selected);

      g.beginPath();
      g.arc(xy[0], xy[1], on ? 9 : 4.5, 0, Math.PI * 2);
      g.fillStyle = on ? 'rgba(110,168,254,0.9)' : 'rgba(230,233,238,0.35)';
      g.fill();

      if (on) {
        g.strokeStyle = 'rgba(110,168,254,0.55)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(xy[0] - 22, xy[1]); g.lineTo(xy[0] + 22, xy[1]);
        g.moveTo(xy[0], xy[1] - 22); g.lineTo(xy[0], xy[1] + 22);
        g.stroke();

        g.font = '600 12px Segoe UI, system-ui, sans-serif';
        g.fillStyle = 'rgba(230,233,238,0.9)';
        g.fillText(L.id + '  ' + p[0].toFixed(3) + ' / ' + p[1].toFixed(3) +
                   offsetLabel(L),
                   xy[0] + 14, xy[1] - 12);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Nudging a layer: offset, in canvas pixels.
   *
   * Separate from the pivot on purpose. The pivot is the joint and belongs to
   * the rig; the offset only says the pixels arrived a hair off. Cutting a
   * figure leaves a part two or three pixels out of place often enough that
   * the alternative was re-cutting the image for a seam nobody can see once
   * it moves.
   * ------------------------------------------------------------------ */

  /* The layer's own offset, ignoring any mood - what a mood's value replaces,
   * per docs/figure-json.md ("a mood's value replaces the layer's, it does
   * not add to it"). */
  function baseOffsetOf(L) {
    var o = L.offset;
    return [(o && +o[0]) || 0, (o && +o[1]) || 0];
  }

  /* What the panel shows and what dragging or nudging moves: the current
   * mood's override when there is one, the layer's own offset otherwise -
   * "show values as the mood sees them". */
  function effectiveOffsetOf(L) {
    var ov = moodOverrideOf(L.id);
    if (ov && Array.isArray(ov.offset) && ov.offset.length === 2) {
      return [(+ov.offset[0]) || 0, (+ov.offset[1]) || 0];
    }
    return baseOffsetOf(L);
  }

  function offsetOf(L) { return effectiveOffsetOf(L); }

  function offsetLabel(L) {
    var o = offsetOf(L);
    if (!o[0] && !o[1]) return '';
    return '   ' + (o[0] > 0 ? '+' : '') + o[0] + ' / ' +
           (o[1] > 0 ? '+' : '') + o[1] + ' px';
  }

  /* Written back at one decimal. A drag on a stage scaled to a third of the
   * canvas produces numbers like 2.6666667, and figure.json is read by
   * people. The running total is kept in stage coordinates, not here, so
   * rounding cannot make a slow drag stand still.
   *
   * In a mood this writes only the override: the new value is compared
   * against the layer's own offset (not against zero), because a mood's
   * offset legitimately replaces a non-zero cutting correction with [0, 0] -
   * that is a real difference, not "no override". The override is only
   * dropped once dragging brings it back to exactly what neutral already
   * shows. */
  function nudgeLayer(L, dx, dy) {
    var o = effectiveOffsetOf(L);
    var x = Math.round((o[0] + dx) * 10) / 10;
    var y = Math.round((o[1] + dy) * 10) / 10;
    if (state.mood !== 'neutral') {
      var base = baseOffsetOf(L);
      if (x === base[0] && y === base[1]) clearOverride(L.id, null, 'offset');
      else setOverride(L.id, null, 'offset', [x, y]);
    } else if (x === 0 && y === 0) {
      delete L.offset;
    } else {
      L.offset = [x, y];
    }
    refreshStill();
    buildLayerList();
    /* The reset button beside the read-only offset line in the Layer card
     * only exists while a mood is selected, and only there does dragging
     * need to make it appear or disappear. */
    if (state.mood !== 'neutral') buildLayerCard();
    refreshSaveState();
  }

  var ARROW_STEP = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    ArrowUp: [0, -1], ArrowDown: [0, 1]
  };

  function bindNudgeKeys() {
    window.addEventListener('keydown', function (e) {
      var step = ARROW_STEP[e.key];
      if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
      /* An arrow key inside a slider or a text box belongs to that box. */
      var tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      var L = selectedLayer();
      if (!L) return;
      var k = e.shiftKey ? 10 : 1;
      e.preventDefault();
      nudgeLayer(L, step[0] * k, step[1] * k);
    });
  }

  function bindPivotDrag() {
    var c = $('overlay');

    function nearestPivot(cx, cy) {
      var f = state.figure;
      if (!f) return null;
      var m = viewMap();
      var best = null, bestD = 1e9;
      var layers = f.layers || [];
      for (var i = 0; i < layers.length; i++) {
        var p = layers[i].pivot || [0.5, 0.5];
        var xy = project(m, p[0] * m.w, p[1] * m.h);
        var d = Math.hypot(xy[0] - cx, xy[1] - cy);
        if (d < bestD) { bestD = d; best = layers[i]; }
      }
      /* A radius in overlay pixels, so the dot is as easy to grab at 4x as
       * it is at 1x - it is the dot on screen you are aiming at, not an area
       * of the figure. */
      return bestD < 26 * m.dpr ? best : null;
    }

    function pos(e) {
      var r = c.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
    }

    function startPan(e) {
      state.panning = {
        x: e.clientX, y: e.clientY,
        px: view.panX, py: view.panY
      };
      c.classList.add('grabbing');
      e.preventDefault();
    }

    /* One overlay, four jobs, in this order. The pivot dots sit on top of
     * the very pixels you want to drag, so the two that share a plain left
     * button are separated by distance: within reach of a dot you are moving
     * the joint, everywhere else you are moving the view. Nothing is taken
     * away by that - the empty case did nothing at all before. */
    c.addEventListener('mousedown', function (e) {
      /* The middle button always pans, for the times you want to push the
       * figure while the pointer happens to be over a joint. */
      if (e.button === 1) { startPan(e); return; }

      /* A part being placed owns the left button until it is placed or
       * cancelled. It is the only thing on screen that is not yet real. */
      if (place.img && e.button === 0) {
        var sp0 = overlayToStage(pos(e)[0], pos(e)[1]);
        state.placing = [sp0[0] - place.x, sp0[1] - place.y];
        e.preventDefault();
        return;
      }

      /* While marking, the left button belongs to the brush and the right
       * one erases. Panning is still on the middle button and the wheel, so
       * nothing has to be given up to paint. */
      if (marks.on && (e.button === 0 || e.button === 2)) {
        marks.erasing = (e.button === 2) || e.altKey;
        marks.last = null;
        var s = overlayToStage(pos(e)[0], pos(e)[1]);
        paintTo(s[0], s[1], marks.erasing);
        state.painting = true;
        e.preventDefault();
        return;
      }

      if (e.button !== 0) return;

      var p = pos(e);

      if (e.altKey && selectedLayer()) {
        state.nudging = overlayToStage(p[0], p[1]);
        e.preventDefault();
        return;
      }

      var L = nearestPivot(p[0], p[1]);
      if (L) {
        state.selected = L.id;
        /* The pivot is the rig, fixed for every mood - selecting the layer
         * by its dot still works, dragging it does not. */
        state.dragging = (state.mood === 'neutral');
        buildLayerList();
        buildLayerCard();
        buildMotionControls();
        e.preventDefault();
        return;
      }

      startPan(e);
    });

    /* Back to the whole figure. The button in the transport does the same
     * thing; this is the one you find without looking for it. */
    c.addEventListener('dblclick', function () { resetView(); });

    /* passive: false, or the browser scrolls the page and ignores the
     * preventDefault. A trackpad pinch arrives here as a wheel event with
     * ctrlKey set and a larger delta, which the zoom line handles as it is. */
    c.addEventListener('wheel', function (e) {
      if (!state.figure) return;
      e.preventDefault();

      /* A tilt wheel, a thumb wheel or a sideways trackpad swipe all arrive
       * as deltaX. Shift turns the main wheel sideways for hardware that has
       * only the one. */
      var dx = e.shiftKey ? (e.deltaX || e.deltaY) : e.deltaX;
      var dy = e.shiftKey ? 0 : e.deltaY;

      /* One event can carry both, and a trackpad diagonal carries both every
       * time. The larger one wins, or the figure zooms and slides at once
       * and neither move is the one that was asked for. */
      if (Math.abs(dx) > Math.abs(dy)) {
        /* In screen pixels, like the drag, and against the wheel: pushing
         * the view right is what moves the figure left. */
        panBy(-dx, 0);
        return;
      }

      if (!dy) return;
      var p = pos(e);
      /* Multiplicative, so a notch is worth the same fraction at every
       * zoom. Adding a constant makes the far end crawl and the near end
       * jump. */
      zoomAt(view.zoom * Math.exp(-dy * 0.0015), p[0], p[1]);
    }, { passive: false });

    window.addEventListener('mousemove', function (e) {
      if (state.placing) {
        var sp1 = overlayToStage(pos(e)[0], pos(e)[1]);
        place.x = sp1[0] - state.placing[0];
        place.y = sp1[1] - state.placing[1];
        drawPlace();
        return;
      }
      if (state.painting) {
        var sp = overlayToStage(pos(e)[0], pos(e)[1]);
        paintTo(sp[0], sp[1], marks.erasing);
        return;
      }
      if (state.panning) {
        view.panX = state.panning.px + (e.clientX - state.panning.x);
        view.panY = state.panning.py + (e.clientY - state.panning.y);
        applyView();
        drawOverlay();
        return;
      }
      if (state.nudging) {
        var sel = selectedLayer();
        if (!sel) return;
        var now = overlayToStage(pos(e)[0], pos(e)[1]);
        nudgeLayer(sel, now[0] - state.nudging[0], now[1] - state.nudging[1]);
        state.nudging = now;
        return;
      }
      if (!state.dragging) return;
      var L = selectedLayer();
      if (!L) return;
      var p = pos(e);
      var f = state.figure;
      var w = (f.size && f.size.width) || 1000;
      var h = (f.size && f.size.height) || 1000;
      var s = overlayToStage(p[0], p[1]);
      L.pivot = [
        Math.round((s[0] / w) * 1000) / 1000,
        Math.round((s[1] / h) * 1000) / 1000
      ];
      refreshStill();
      buildLayerList();
    });

    window.addEventListener('mouseup', function () {
      state.placing = null;
      if (state.painting) {
        state.painting = false;
        marks.last = null;
        /* Once per stroke, not once per frame: the count reads the whole
         * mask, which is 1.8 million pixels on pedro. */
        countParts();
        buildPartList();
      }
      state.dragging = false;
      state.nudging = null;
      if (state.panning) {
        state.panning = null;
        c.classList.remove('grabbing');
      }
    });
  }

  /* ================================================================== *
   * Contact sheet - 24 frames of the window in one image
   * ================================================================== */

  /* The stage background is a review choice, not part of the figure.
   * Transparent draws a checkerboard, so alpha edges stay readable; a solid
   * colour shows how the figure sits against a real page. The contact sheet
   * paints the same thing, so sheet and stage never disagree. */
  function paintStageBg(g, w, h) {
    if (state.stageBg) {
      g.fillStyle = state.stageBg;
      g.fillRect(0, 0, w, h);
      return;
    }
    /* Same two colours as the stage's CSS checkerboard, and an integer cell.
     * A fractional cell made the parity flip in the wrong column and drew
     * some squares double width; different colours meant an alpha edge read
     * differently in the sheet than on the stage it was chosen from, which
     * is the exact judgement the checkerboard exists to support. */
    var cell = CHECKER_CELL;
    g.fillStyle = CHECKER_A;
    g.fillRect(0, 0, w, h);
    g.fillStyle = CHECKER_B;
    var cols = Math.ceil(w / cell), rowsN = Math.ceil(h / cell);
    for (var yi = 0; yi < rowsN; yi++) {
      for (var xi = 0; xi < cols; xi++) {
        if ((xi + yi) % 2 === 0) g.fillRect(xi * cell, yi * cell, cell, cell);
      }
    }
  }

  function setStageBg(colour, btn) {
    state.stageBg = colour || null;
    var col = document.querySelector('.stage-col');
    if (colour) {
      col.classList.add('solid');
      col.style.backgroundColor = colour;
    } else {
      col.classList.remove('solid');
      col.style.backgroundColor = '';
    }
    var sws = document.querySelectorAll('.swatches .sw');
    for (var i = 0; i < sws.length; i++) sws[i].classList.remove('on');
    if (btn) btn.classList.add('on');
  }

  var SHEET_COLS = 6, SHEET_ROWS = 4, SHEET_CELL = 260;
  var CHECKER_A = '#14171b', CHECKER_B = '#191c21', CHECKER_CELL = 10;
  var SEAM_COLORS = ['#4a4a4a', '#e06c75', '#6fcf7f', '#6ea8fe', '#e0a458',
                     '#c678dd', '#56b6c2', '#d19a66', '#98c379', '#be5046'];

  function buildSheet() {
    if (!state.images) return;
    var c = $('sheet');
    c.width = SHEET_COLS * SHEET_CELL;
    c.height = SHEET_ROWS * SHEET_CELL;
    var g = c.getContext('2d');
    paintStageBg(g, c.width, c.height);

    var tmp = document.createElement('canvas');
    tmp.width = SHEET_CELL; tmp.height = SHEET_CELL;
    var tg = tmp.getContext('2d');

    var n = SHEET_COLS * SHEET_ROWS;
    for (var i = 0; i < n; i++) {
      var t = (i / n) * state.window;
      tg.setTransform(1, 0, 0, 1, 0, 0);
      tg.clearRect(0, 0, SHEET_CELL, SHEET_CELL);
      Idle.drawFrame(tg, state.figure, state.images, t, {
        width: SHEET_CELL, height: SHEET_CELL,
        background: false,
        /* The sheet judges whichever mood the panel has selected, with no
         * blend - the same thing the stage shows. */
        ctx: { state: moodCtxState() }
      });
      var x = (i % SHEET_COLS) * SHEET_CELL;
      var y = Math.floor(i / SHEET_COLS) * SHEET_CELL;
      g.drawImage(tmp, x, y);

      g.font = '600 13px Segoe UI, system-ui, sans-serif';
      g.fillStyle = 'rgba(0,0,0,0.65)';
      g.fillRect(x + 4, y + 4, 52, 19);
      g.fillStyle = '#e6e9ee';
      g.fillText(t.toFixed(2) + 's', x + 9, y + 18);

      g.strokeStyle = 'rgba(42,48,56,0.9)';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, SHEET_CELL - 1, SHEET_CELL - 1);
    }
  }

  /* ------------------------------------------------------------------ *
   * Event scan.
   *
   * A blink lasts about 70 ms. A 24 frame sheet samples every 330 ms, so it
   * misses roughly three blinks out of four - measured, not guessed. The
   * sheet shows how the figure moves; this list proves that the short events
   * happen at all, and at a believable spacing.
   * ------------------------------------------------------------------ */

  function scanEvents(seconds, fps) {
    seconds = seconds || 30;
    fps = fps || 60;
    var f = state.figure;
    var layers = f.layers || [];
    var watch = [];
    /* A layer that carries the blink motion but no eyesOpen/eyesClosed role
     * of its own never has its `hidden` bit touched by the blink (idle.js
     * sets state[i].hidden from state[i].role, not from an ancestor's) - it
     * drives nothing visible, and scanning it just reports "always off".
     * blinkTrouble() already warns about this on the Layer card; here it is
     * kept out of the scan and named instead. */
    var noRole = [];
    var i, j;

    for (i = 0; i < layers.length; i++) {
      var L = layers[i];
      var ms = L.motions || [];
      for (j = 0; j < ms.length; j++) {
        if (ms[j].type === 'blink') {
          if (L.role === 'eyesOpen' || L.role === 'eyesClosed') {
            watch.push({ id: L.id, kind: 'blink', role: L.role });
          } else {
            noRole.push(L.id);
          }
        }
        if (ms[j].type === 'flipbook' && ms[j].mode === 'burst') {
          watch.push({ id: L.id, kind: 'burst' });
        }
      }
    }
    if (!watch.length) return { events: [], watched: [], noRole: noRole };

    var open = {}, events = [];
    var n = Math.round(seconds * fps);
    /* Strictly less than n: sampling t = 0 ... 30.000 inclusive reported a
     * fourth burst "in 30 s" with a duration of 0 ms, which then poisoned
     * the min of the range. */
    for (i = 0; i < n; i++) {
      var t = i / fps;
      /* Whichever mood the panel has selected, with no blend - `state` here
       * is the object this function closes over (state.mood is undefined,
       * i.e. neutral, for a caller - such as the agreement test - that never
       * sets one), read directly rather than through a helper so this stays
       * one self-contained block a test can lift out and run on its own. */
      var st = Idle.solve(f, t, {
        pointerX: 0, pointerY: 0,
        state: (state.mood && state.mood !== 'neutral') ? state.mood : undefined
      });
      var by = {};
      for (j = 0; j < st.length; j++) by[st[j].id] = st[j];

      for (j = 0; j < watch.length; j++) {
        var w = watch[j];
        var s = by[w.id];
        /* eyesOpen disappears while the lid is down, so "hidden" is the
         * blink; eyesClosed is the other way round, drawn only while the
         * lid is down, so it is the shut eye precisely when it is NOT
         * hidden. Same rule idle.js's solve() uses for state[i].hidden. */
        var on = w.kind === 'blink'
          ? (w.role === 'eyesClosed' ? !s.hidden : !!s.hidden)
          : (s.frame >= 0);
        var key = w.id + '|' + w.kind;
        if (on && !open[key]) open[key] = { id: w.id, kind: w.kind, a: t, b: t };
        else if (on) open[key].b = t;
        else if (open[key]) { events.push(open[key]); open[key] = null; }
      }
    }
    for (var k in open) { if (open[k]) events.push(open[k]); }
    events.sort(function (a, b) { return a.a - b.a; });
    return { events: events, watched: watch, seconds: seconds, noRole: noRole };
  }

  function renderEvents() {
    var box = $('eventsOut');
    if (!state.figure) { box.textContent = 'No figure loaded.'; return; }
    var r = scanEvents(30, 60);
    if (!r.watched.length && !r.noRole.length) {
      box.textContent = 'No blink and no burst in this figure.';
      return;
    }
    var noRoleLines = r.noRole.map(function (id) {
      return id + ' blink: no eyesOpen or eyesClosed role on this layer, nothing to scan.';
    });
    if (!r.watched.length) {
      box.textContent = noRoleLines.join('\n');
      return;
    }
    var byId = {};
    for (var i = 0; i < r.events.length; i++) {
      var e = r.events[i];
      var k = e.id + ' ' + e.kind;
      if (!byId[k]) byId[k] = [];
      byId[k].push(e);
    }
    var lines = noRoleLines.slice();
    if (!r.events.length) {
      var names = r.watched.map(function (w) { return w.id + ' ' + w.kind; }).join(', ');
      lines.push('Watched ' + names + ' over ' + r.seconds +
        ' s and nothing fired.\n' +
        'A blink only hides a layer that carries role "eyesOpen" (or shows ' +
        'one that carries "eyesClosed"), with the blink motion on that ' +
        'layer or an ancestor.');
      box.textContent = lines.join('\n');
      return;
    }
    for (var key in byId) {
      var list = byId[key];
      var durs = [], gaps = [];
      for (i = 0; i < list.length; i++) {
        durs.push(Math.round((list[i].b - list[i].a) * 1000));
        if (i) gaps.push(list[i].a - list[i - 1].a);
      }
      var gapTxt = gaps.length
        ? (Math.min.apply(null, gaps).toFixed(1) + '-' + Math.max.apply(null, gaps).toFixed(1) + ' s apart')
        : 'only once';
      lines.push(key + ': ' + list.length + ' in 30 s, ' +
                 Math.min.apply(null, durs) + '-' + Math.max.apply(null, durs) + ' ms, ' + gapTxt);
      var firsts = [];
      for (i = 0; i < Math.min(list.length, 6); i++) firsts.push(list[i].a.toFixed(2));
      lines.push('    at ' + firsts.join(', ') + (list.length > 6 ? ', ...' : ''));
    }
    box.textContent = lines.join('\n');
  }

  /* ================================================================== *
   * Export - resized layers plus figure.json, as a zip
   * ================================================================== */

  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* Minimal ZIP writer, stored (no compression). WebP and PNG are already
   * compressed, so deflate would only cost time. */
  function makeZip(files) {
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;

    for (var i = 0; i < files.length; i++) {
      var nameU8 = enc.encode(files[i].name);
      var data = files[i].data;
      var crc = crc32(data);
      /* Names go in as UTF-8, so general purpose bit 11 has to say so.
       * Without it a path like layers/gruss-oel.webp with real umlauts came
       * back mojibake from both Python's zipfile and unzip, which read it as
       * CP437 - and the figure.json inside still pointed at the real name,
       * so the extracted folder did not load. */
      var flags = (nameU8.length === files[i].name.length) ? 0 : 0x0800;

      var lh = new Uint8Array(30 + nameU8.length);
      var v = new DataView(lh.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, flags, true);
      v.setUint16(8, 0, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, 0x2821, true);
      v.setUint32(14, crc, true);
      v.setUint32(18, data.length, true);
      v.setUint32(22, data.length, true);
      v.setUint16(26, nameU8.length, true);
      v.setUint16(28, 0, true);
      lh.set(nameU8, 30);

      parts.push(lh, data);

      var ch = new Uint8Array(46 + nameU8.length);
      var w = new DataView(ch.buffer);
      w.setUint32(0, 0x02014b50, true);
      w.setUint16(4, 20, true);
      w.setUint16(6, 20, true);
      w.setUint16(8, flags, true);
      w.setUint16(10, 0, true);
      w.setUint16(12, 0, true);
      w.setUint16(14, 0x2821, true);
      w.setUint32(16, crc, true);
      w.setUint32(20, data.length, true);
      w.setUint32(24, data.length, true);
      w.setUint16(28, nameU8.length, true);
      w.setUint32(42, offset, true);
      ch.set(nameU8, 46);
      central.push(ch);

      offset += lh.length + data.length;
    }

    var cdSize = 0;
    for (i = 0; i < central.length; i++) cdSize += central[i].length;

    var end = new Uint8Array(22);
    var e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, files.length, true);
    e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true);
    e.setUint32(16, offset, true);

    return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
  }

  function canvasToU8(canvas, mime, q) {
    return new Promise(function (res, rej) {
      canvas.toBlob(function (b) {
        if (!b) { rej(new Error('canvas gab kein Bild zurueck')); return; }
        b.arrayBuffer().then(function (ab) { res(new Uint8Array(ab)); }, rej);
      }, mime, q);
    });
  }

  /* The smallest rectangle of an image that paints anything, as
   * [x0, y0, x1, y1] in the image's own pixels, x1/y1 exclusive, with a
   * 2 px margin for soft edges. The same rule as the loading screen's
   * tools/zuschneiden.py, so an export and that tool cut alike:
   *
   *   - visible means alpha above 0;
   *   - under blend "screen" black disappears, so there it also has to be
   *     brighter than 6 (the luma PIL's convert("L") uses: 299/587/114),
   *     unless nothing at all passes that, in which case alpha decides;
   *   - an image that paints nothing keeps a 1x1 box plus the margin, so
   *     the layer stays in the tree and its children keep their parent. */
  var CROP_MARGIN = 2;

  function visibleBox(img, screen) {
    var nw = img.naturalWidth, nh = img.naturalHeight;
    var cv = document.createElement('canvas');
    cv.width = nw; cv.height = nh;
    var g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    var d = g.getImageData(0, 0, nw, nh).data;

    function scan(lit) {
      var x0 = nw, y0 = nh, x1 = -1, y1 = -1;
      for (var y = 0; y < nh; y++) {
        var row = y * nw * 4;
        for (var x = 0; x < nw; x++) {
          var o = row + x * 4;
          if (!d[o + 3]) continue;
          if (lit && d[o] * 299 + d[o + 1] * 587 + d[o + 2] * 114 <= 6000) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
      return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
    }

    var box = (screen && scan(true)) || scan(false) || [0, 0, 1, 1];
    return [Math.max(0, box[0] - CROP_MARGIN), Math.max(0, box[1] - CROP_MARGIN),
            Math.min(nw, box[2] + CROP_MARGIN), Math.min(nh, box[3] + CROP_MARGIN)];
  }

  /* export pixel scaling */
  /* A few values in figure.json are canvas pixels, not the 0..1 fractions
   * pivots and depths use, so they do not shrink on their own when a sized
   * export scales `f.size` down. Left alone, Pedro exported at 1000 wide
   * (master 1792, scale 0.558) keeps his master-size offsets, gaze reach and
   * drift rise - all 1.8x too large against the smaller canvas.
   *
   * sx and sy can differ by a hair, because the exported height is rounded
   * (Pedro at 1000 is 1000 x 558, not 1000 x 558.04 - see the comment above
   * `sx`/`sy` in exportFigure). Every value below moves along one axis and
   * takes that axis's factor, except gaze `pixels`: it drives both tx and ty
   * at once (idle.js's gaze block) with no x/y split of its own, so it takes
   * sx - the gap against sy is under a tenth of a percent and does not show.
   *
   * Pure and lifted out so tools/test-agreement.mjs can hold it to the same
   * pixel keys the engine reads (MOTIONS.gaze, MOTIONS.drift) and the same
   * rounding nudgeLayer already uses for offset. */
  function scaleExportPixels(figure, sx, sy) {
    function r1(v) { return Math.round(v * 10) / 10; }
    var layers = figure.layers || [];
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      if (Array.isArray(L.offset) && L.offset.length === 2) {
        L.offset = [r1(L.offset[0] * sx), r1(L.offset[1] * sy)];
      }
      var motions = L.motions || [];
      for (var j = 0; j < motions.length; j++) {
        var m = motions[j];
        if (m.type === 'gaze') {
          if (typeof m.pixels === 'number') m.pixels = r1(m.pixels * sx);
        } else if (m.type === 'drift') {
          if (typeof m.dx === 'number') m.dx = r1(m.dx * sx);
          if (typeof m.dy === 'number') m.dy = r1(m.dy * sy);
          if (typeof m.wander === 'number') m.wander = r1(m.wander * sx);
        }
      }
    }
    /* A mood's own offset and gaze/drift overrides are canvas pixels too,
     * for the same reason as above - they do not shrink with f.size on their
     * own just because the layer they sit over did. */
    var states = figure.states;
    if (states) {
      for (var name in states) {
        if (!Object.prototype.hasOwnProperty.call(states, name)) continue;
        var tab = states[name];
        if (!tab || typeof tab !== 'object') continue;
        for (var id in tab) {
          if (!Object.prototype.hasOwnProperty.call(tab, id)) continue;
          var ov = tab[id];
          if (!ov || typeof ov !== 'object') continue;
          if (Array.isArray(ov.offset) && ov.offset.length === 2) {
            ov.offset = [r1(ov.offset[0] * sx), r1(ov.offset[1] * sy)];
          }
          if (ov.gaze && typeof ov.gaze === 'object' && typeof ov.gaze.pixels === 'number') {
            ov.gaze.pixels = r1(ov.gaze.pixels * sx);
          }
          if (ov.drift && typeof ov.drift === 'object') {
            if (typeof ov.drift.dx === 'number') ov.drift.dx = r1(ov.drift.dx * sx);
            if (typeof ov.drift.dy === 'number') ov.drift.dy = r1(ov.drift.dy * sy);
            if (typeof ov.drift.wander === 'number') ov.drift.wander = r1(ov.drift.wander * sx);
          }
        }
      }
    }
    return figure;
  }
  /* end of export pixel scaling */

  function exportFigure() {
    if (!state.images) return;
    var out = $('exportOut');
    out.textContent = 'rendering...';

    var target = parseInt($('exportSize').value, 10) || 0;
    var f = JSON.parse(JSON.stringify(state.figure));
    var src = state.figure;
    var w = (src.size && src.size.width) || 1000;
    var h = (src.size && src.size.height) || 1000;
    var scale = target ? target / w : 1;

    var files = [];
    var renamed = {};
    var base = state.base || '';
    var layers = src.layers || [];

    /* Every layer image ships cut to the rectangle it paints, and figure.json
     * says where that rectangle sits (`crop` / `crops`, read by cropOf in
     * idle.js). The layer box stays the full canvas, so nothing about the rig
     * changes - only the decoded memory does, which on the loading screen
     * went from 547 MB to 34 MB across all figures.
     *
     * Per file, not per layer: two layers showing one file share one cut.
     * A file counts as screen-only when every layer using it is screen. */
    var uses = {}, order = [];
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var bank = state.images[L.id] || [];
      /* Every picture the layer can show, moods included - the same list
       * imagesOf() hands loadImages() and the DOM builder, so a mood picture
       * is exported and cropped exactly as its own layer's src is. A frames
       * layer's list is just its frames, as before: a mood cannot swap a
       * picture on one of those, so this changes nothing for it. */
      var pics = Idle.imagesOf(L, src);
      for (var k = 0; k < pics.length; k++) {
        var p = pics[k];
        if (!p.src) continue;
        var img = (bank.bySrc && bank.bySrc[p.src]) || bank[k];
        if (!img) continue;
        var u = uses[p.src];
        if (!u) {
          /* Where the file sits on the canvas now: all of it, or the crop it
           * already carries if this figure was cut before - the layer's own
           * for its own file, a mood's override for one only a mood shows,
           * exactly what imagesOf() itself resolves when two moods share a
           * file. */
          u = uses[p.src] = { img: img, screen: true, place: p.crop || [0, 0, w, h] };
          order.push(p.src);
        }
        if (L.blend !== 'screen') u.screen = false;
      }
    }

    /* Per axis, because the exported height is rounded: Pedro at 1000 is
     * 1000 x 558, not 1000 x 558.04. With one factor for both, a part that
     * reached the bottom edge got a rectangle one pixel past the canvas and
     * a half-transparent last row. The epsilon keeps 1000 * 0.558 from
     * rounding up to 559. */
    var sx = scale;
    var sy = target ? Math.round(h * scale) / h : 1;
    var EPS = 1e-6;

    var cropOfPath = {};
    var before = 0, after = 0;
    /* Lossy WebP either way. At master 0.94, the quality zuschneiden.py
     * uses; below master 0.92 as before. The master used to copy the
     * original bytes, but a cut file is a new file and has to be encoded. */
    var quality = scale === 1 ? 0.94 : 0.92;

    function cutOne(path) {
      var u = uses[path];
      var img = u.img, P = u.place;
      var kx = P[2] / img.naturalWidth, ky = P[3] / img.naturalHeight;
      var b = visibleBox(img, u.screen);
      /* The painted part in figure-canvas pixels, then in export pixels,
       * rounded outwards so no painted pixel falls off the edge. */
      var cx = P[0] + b[0] * kx, cy = P[1] + b[1] * ky;
      var cw = (b[2] - b[0]) * kx, ch = (b[3] - b[1]) * ky;
      var ox = Math.floor(cx * sx + EPS), oy = Math.floor(cy * sy + EPS);
      var ow = Math.max(1, Math.ceil((cx + cw) * sx - EPS) - ox);
      var oh = Math.max(1, Math.ceil((cy + ch) * sy - EPS) - oy);

      var cv = document.createElement('canvas');
      cv.width = ow; cv.height = oh;
      var g = cv.getContext('2d');
      g.imageSmoothingQuality = 'high';
      /* The source rectangle is the export rectangle mapped back into the
       * image, so the rounding above moves no pixel. At master it is an
       * exact integer copy. */
      g.drawImage(img, (ox / sx - P[0]) / kx, (oy / sy - P[1]) / ky,
                  ow / sx / kx, oh / sy / ky, 0, 0, ow, oh);

      cropOfPath[path] = [ox, oy, ow, oh];
      before += Math.round(P[2] * sx) * Math.round(P[3] * sy) * 4;
      after += ow * oh * 4;

      var out8 = path.replace(/\.[^.\/]+$/, '.webp');
      if (out8 !== path) renamed[path] = out8;
      return canvasToU8(cv, 'image/webp', quality).then(function (u8) {
        files.push({ name: out8, data: u8 });
      });
    }

    /* One file at a time, with a breath between, so the page can say how
     * far it got instead of freezing for the length of a big figure. */
    var chain = Promise.resolve();
    order.forEach(function (path, n) {
      chain = chain.then(function () {
        out.textContent = 'cutting ' + (n + 1) + ' of ' + order.length + ' ...';
        return new Promise(function (res) { setTimeout(res, 0); });
      }).then(function () { return cutOne(path); });
    });

    /* The backdrop is not a layer: it covers the host and is never cut. At
     * master it keeps its original bytes, below master it is scaled. */
    if (src.background && state.images._bg) {
      var bgPath = src.background, bgImg = state.images._bg;
      chain = chain.then(function () {
        if (scale === 1) {
          return fetch(Idle.resolveSrc(src, base, bgPath))
            .then(function (r) {
              if (!r.ok) throw new Error(bgPath + ': ' + r.status);
              return r.arrayBuffer();
            })
            .then(function (ab) { files.push({ name: bgPath, data: new Uint8Array(ab) }); });
        }
        var cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(bgImg.naturalWidth * scale));
        cv.height = Math.max(1, Math.round(bgImg.naturalHeight * scale));
        var g = cv.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(bgImg, 0, 0, cv.width, cv.height);
        var out8 = bgPath.replace(/\.[^.\/]+$/, '.webp');
        if (out8 !== bgPath) renamed[bgPath] = out8;
        return canvasToU8(cv, 'image/webp', 0.92).then(function (u8) {
          files.push({ name: out8, data: u8 });
        });
      });
    }

    if (target) {
      /* The player defaults a missing size to 1000, so the export has to use
       * the same default. Falling back to the width instead was wrong by 20%
       * on an 800x1000 figure, and reading src.size.height when there is no
       * size at all threw. */
      f.size = { width: target, height: Math.round(h * scale) };
      /* offset, gaze pixels and drift dx/dy/wander are canvas pixels in the
       * player, not fractions of the canvas - they do not shrink on their
       * own just because f.size did. */
      scaleExportPixels(f, sx, sy);
    }
    delete f.sources;

    chain.then(function () {
      /* Write the rectangles, then point the JSON at the names actually
       * written. crops runs parallel to frames; a src layer gets one crop. */
      if (f.background && renamed[f.background]) f.background = renamed[f.background];
      for (var q = 0; q < (f.layers || []).length; q++) {
        var FL = f.layers[q];
        delete FL.crop;
        delete FL.crops;
        if (FL.frames && FL.frames.length) {
          var rects = FL.frames.map(function (p) { return cropOfPath[p] || null; });
          if (rects.every(Boolean)) FL.crops = rects;
          FL.frames = FL.frames.map(function (p) { return renamed[p] || p; });
        } else if (FL.src) {
          if (cropOfPath[FL.src]) FL.crop = cropOfPath[FL.src];
          if (renamed[FL.src]) FL.src = renamed[FL.src];
        }
      }

      /* A mood's own src is a picture too, cut and renamed the same way -
       * `f.states` is already a deep copy (f came off JSON.parse(JSON.
       * stringify(state.figure))), so this only ever touches the export. */
      if (f.states) {
        for (var moodName in f.states) {
          if (!Object.prototype.hasOwnProperty.call(f.states, moodName)) continue;
          var tab = f.states[moodName];
          if (!tab || typeof tab !== 'object') continue;
          for (var layerId in tab) {
            if (!Object.prototype.hasOwnProperty.call(tab, layerId)) continue;
            var ov = tab[layerId];
            if (!ov || typeof ov !== 'object' || typeof ov.src !== 'string' || !ov.src) continue;
            delete ov.crop;
            if (cropOfPath[ov.src]) ov.crop = cropOfPath[ov.src];
            if (renamed[ov.src]) ov.src = renamed[ov.src];
          }
        }
      }

      var enc = new TextEncoder();
      files.push({ name: 'figure.json', data: enc.encode(JSON.stringify(f, null, 2)) });
      var blob = makeZip(files);
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = state.name + (target ? '-' + target : '-master') + '.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      var mb = function (n) { return (n / 1048576).toFixed(1) + ' MB'; };
      out.textContent = files.length + ' files, ' + Math.round(blob.size / 1024) +
        ' KB. Decoded layers ' + mb(before) + ' -> ' + mb(after) + '.';
    }).catch(function (e) {
      out.textContent = 'Export fehlgeschlagen: ' + ((e && e.message) || e);
    });
  }

  /* ================================================================== *
   * IoU - how well did the machine cut match the hand-made truth
   * ================================================================== */

  function buildIouTruthList() {
    var sel = $('iouTruth');
    sel.innerHTML = '';
    var layers = state.figure ? (state.figure.layers || []) : [];
    var seen = {};
    for (var i = 0; i < layers.length; i++) {
      var srcs = (layers[i].frames && layers[i].frames.length)
        ? layers[i].frames : [layers[i].src];
      for (var k = 0; k < srcs.length; k++) {
        if (!srcs[k] || seen[srcs[k]]) continue;
        seen[srcs[k]] = 1;
        var o = document.createElement('option');
        o.value = srcs[k];
        o.textContent = srcs[k].replace(/^layers\//, '');
        sel.appendChild(o);
      }
    }
  }

  /* A binary alpha mask, letterboxed into a square - never stretched.
   *
   * The old version did drawImage(img, 0, 0, 512, 512), which warps any
   * non-square input. Measured: a pixel-identical copy of head.webp re-saved
   * on a 1400x1000 canvas scored 0.184, and a pixel-perfect cut cropped to
   * its own bounding box scored 0.148 and was matched to the wrong layer.
   * Every layerize model returns exactly that shape of input. */
  function maskOf(img, size, crop) {
    var sw = img.naturalWidth || img.width;
    var sh = img.naturalHeight || img.height;
    var sx = 0, sy = 0;
    if (crop) {
      var b = alphaBox(img);
      if (b) { sx = b[0]; sy = b[1]; sw = b[2]; sh = b[3]; }
    }

    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var g = c.getContext('2d', { willReadFrequently: true });
    var k = Math.min(size / sw, size / sh);
    var dw = sw * k, dh = sh * k;
    g.drawImage(img, sx, sy, sw, sh, (size - dw) / 2, (size - dh) / 2, dw, dh);

    var d = g.getImageData(0, 0, size, size).data;
    var m = new Uint8Array(size * size);
    for (var i = 0, j = 3; i < m.length; i++, j += 4) {
      if (d[j] > 8) m[i] = 1;
    }
    return m;
  }

  /* Tightest rectangle containing any non-transparent pixel. */
  function alphaBox(img) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var step = Math.max(1, Math.round(Math.max(w, h) / 512));
    var cw = Math.ceil(w / step), ch = Math.ceil(h / step);
    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, cw, ch);
    var d = g.getImageData(0, 0, cw, ch).data;
    var x0 = cw, y0 = ch, x1 = -1, y1 = -1;
    for (var y = 0; y < ch; y++) {
      for (var x = 0; x < cw; x++) {
        if (d[(y * cw + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return [x0 * step, y0 * step, (x1 - x0 + 1) * step, (y1 - y0 + 1) * step];
  }

  function iou(a, b) {
    var inter = 0, uni = 0;
    for (var i = 0; i < a.length; i++) {
      var x = a[i], y = b[i];
      if (x & y) inter++;
      if (x | y) uni++;
    }
    /* Two empty masks are not a perfect match, they are no measurement. */
    return uni ? inter / uni : NaN;
  }

  function loadImg(url) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('cannot load ' + url)); };
      im.src = url;
    });
  }

  /* Every image file the figure references, once. */
  function truthPaths() {
    var layers = (state.figure && state.figure.layers) || [];
    var seen = {}, out = [];
    for (var i = 0; i < layers.length; i++) {
      var srcs = (layers[i].frames && layers[i].frames.length)
        ? layers[i].frames : [layers[i].src];
      for (var k = 0; k < srcs.length; k++) {
        if (srcs[k] && !seen[srcs[k]]) { seen[srcs[k]] = 1; out.push(srcs[k]); }
      }
    }
    return out;
  }

  var SHAPE_SIZE = 256;   /* cropped to the alpha box first - shape only */
  var PLACE_SIZE = 512;   /* whole canvas - shape and position together */

  function runIou(fileList) {
    var table = $('iouTable');
    table.innerHTML = '';
    if (!state.figure) { table.textContent = 'No figure loaded.'; return; }

    var base = state.base || '';
    var chosen = $('iouTruth').value;
    var auto = $('iouAuto').checked;
    var all = truthPaths();

    var truths = Promise.all(all.map(function (path) {
      return loadImg(Idle.resolveSrc(state.figure, base, path)).then(function (im) {
        return {
          path: path,
          shape: maskOf(im, SHAPE_SIZE, true),
          place: maskOf(im, PLACE_SIZE, false),
          w: im.naturalWidth, h: im.naturalHeight
        };
      }).catch(function () { return null; });
    })).then(function (list) { return list.filter(Boolean); });

    var rows = [];
    var jobs = [];

    for (var i = 0; i < fileList.length; i++) {
      (function (file) {
        var stem = file.name.replace(/\.[^.]+$/, '').toLowerCase();
        var named = null;
        for (var j = 0; j < all.length; j++) {
          var ls = all[j].replace(/^layers\//, '').replace(/\.[^.]+$/, '').toLowerCase();
          if (ls === stem) named = all[j];
        }

        var url = URL.createObjectURL(file);
        jobs.push(Promise.all([loadImg(url), truths])
          .then(function (pair) {
            var img = pair[0], masks = pair[1];
            var mine = {
              shape: maskOf(img, SHAPE_SIZE, true),
              place: maskOf(img, PLACE_SIZE, false),
              w: img.naturalWidth, h: img.naturalHeight
            };

            /* Shape ignores where the cut sits and how big its canvas is,
             * which is the only comparison that survives a model returning a
             * layer cropped to its own bounding box. Place is the strict one
             * and only means anything on a matching canvas. */
            function score(m) {
              var same = (m.w === mine.w && m.h === mine.h);
              return {
                path: m.path,
                shape: iou(mine.shape, m.shape),
                place: same ? iou(mine.place, m.place) : NaN,
                sameCanvas: same
              };
            }

            var want = auto ? null : (named || chosen);
            if (want) {
              for (var k = 0; k < masks.length; k++) {
                if (masks[k].path === want) {
                  rows.push(makeRow(file, score(masks[k]), null, mine));
                  return;
                }
              }
              /* Asked for a named truth that is not there. Say so, rather
               * than silently auto-matching behind an unticked checkbox. */
              rows.push({ name: file.name, truth: want + ' (nicht gefunden)',
                          shape: NaN, place: NaN, margin: null });
              return;
            }

            var best = null, bestV = -1, second = -1;
            for (var n = 0; n < masks.length; n++) {
              var sc = score(masks[n]);
              var v = isNaN(sc.shape) ? -1 : sc.shape;
              if (v > bestV) { second = bestV; bestV = v; best = sc; }
              else if (v > second) { second = v; }
            }
            rows.push(makeRow(file, best, (second >= 0 && bestV >= 0) ? bestV - second : null, mine));
          })
          .catch(function (e) {
            rows.push({ name: file.name, truth: '-', shape: NaN, place: NaN, margin: null });
          })
          .then(function () { URL.revokeObjectURL(url); }));
      })(fileList[i]);
    }

    function makeRow(file, sc, margin, mine) {
      if (!sc) return { name: file.name, truth: '-', shape: NaN, place: NaN, margin: null };
      return {
        name: file.name, truth: sc.path, shape: sc.shape, place: sc.place,
        margin: margin, sameCanvas: sc.sameCanvas
      };
    }

    function cell(text, cls, grey) {
      var td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      if (grey) td.style.color = '#98a1ad';
      return td;
    }

    function band(v) { return v >= 0.85 ? 'good' : (v >= 0.7 ? 'warn' : 'bad'); }

    Promise.all(jobs).then(function () {
      rows.sort(function (a, b) {
        var x = isNaN(a.shape) ? -1 : a.shape;
        var y = isNaN(b.shape) ? -1 : b.shape;
        return x - y;
      });

      var head = document.createElement('tr');
      var titles = ['file', 'best match', 'shape', 'place'];
      for (var t = 0; t < titles.length; t++) {
        var th = cell(titles[t], null, false);
        th.style.color = '#6ea8fe';
        head.appendChild(th);
      }
      table.appendChild(head);

      var sum = 0, n = 0;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var tr = document.createElement('tr');
        tr.appendChild(cell(r.name));

        var note = (r.margin != null && r.margin < 0.15)
          ? '  (+' + r.margin.toFixed(2) + ' unsicher)' : '';
        tr.appendChild(cell(String(r.truth).replace(/^layers\//, '') + note, null, true));

        if (isNaN(r.shape)) {
          tr.appendChild(cell('failed', 'bad'));
        } else {
          tr.appendChild(cell(r.shape.toFixed(3), band(r.shape)));
          sum += r.shape; n++;
        }

        if (r.sameCanvas === false) tr.appendChild(cell('anderes Format', null, true));
        else if (isNaN(r.place)) tr.appendChild(cell('-', null, true));
        else tr.appendChild(cell(r.place.toFixed(3), band(r.place)));

        table.appendChild(tr);
      }

      if (n) {
        var trm = document.createElement('tr');
        var m1 = cell('mean shape of ' + n);
        m1.style.fontWeight = '600';
        var mean = sum / n;
        trm.appendChild(m1);
        trm.appendChild(cell(''));
        trm.appendChild(cell(mean.toFixed(3), band(mean)));
        trm.appendChild(cell(''));
        table.appendChild(trm);
      }
    });
  }

  /* ================================================================== *
   * Wiring
   * ================================================================== */

  function showError(e) {
    var msg = (e && e.message) ? e.message : String(e);
    var box = $('eventsOut');
    if (box) box.textContent = 'Fehler: ' + msg;
    if (window.console && console.error) console.error(msg, e);
  }

  /* ================================================================== *
   * Marking: say which pixels are which part
   *
   * The machine cut does not work, and docs/cutting.md says why. What a
   * model cannot know is which pixels are *meant* to be one part - that a
   * collar belongs to the chest and a strap does not. A person says that in
   * five seconds with a brush, and it is the only thing they have to say:
   * the boundary comes out of the picture, and the rig comes out of the name
   * through the table import-layers.py has carried all along.
   * ================================================================== */

  /* Far apart on purpose. Where two strokes meet, the canvas leaves a blend
   * of the two colours, and the cutter resolves those to the nearest
   * declared colour - which is only right if no blend of two entries lands
   * closer to a third. */
  var PALETTE = [
    [230, 25, 75], [60, 180, 75], [255, 225, 25], [0, 130, 200],
    [245, 130, 48], [145, 30, 180], [70, 240, 240], [240, 50, 230],
    [210, 245, 60], [250, 190, 212], [0, 128, 128], [170, 110, 40],
    [128, 0, 0], [170, 255, 195], [128, 128, 0], [0, 0, 128]
  ];

  var marks = {
    on: false,
    ctx: null,
    parts: [],        /* front first, like the layer list */
    active: 0,
    brush: 40,
    grow: 24,         /* how far a mark may spread past what was painted */
    last: null,       /* previous point of the current stroke, in figure px */
    erasing: false,
    sourceFile: null  /* the flat image, when it came in through the studio */
  };

  function rgbCss(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  /* The same rule slug() uses in cut-by-marks.py and import-layers.py. It is
   * here so the studio can tell in advance which layer ids a cut will
   * produce, and therefore whether the rig on file still describes them. */
  function slugLike(name) {
    var s = String(name || '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    while (s.indexOf('--') >= 0) s = s.replace(/--/g, '-');
    return s.replace(/^-+|-+$/g, '').slice(0, 28);
  }

  function markSay(msg) { $('markOut').textContent = msg || ''; }

  /* The mask lives at the figure's own resolution and wears the same
   * transform as the stage, so painting is done in figure pixels and the
   * canvas is marks.png with no resampling anywhere. */
  function sizeMarks() {
    var c = $('marks');
    var f = state.figure;
    var w = (f && f.size && f.size.width) || 1000;
    var h = (f && f.size && f.size.height) || 1000;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      marks.ctx = c.getContext('2d', { willReadFrequently: true });
    }
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    if (!marks.ctx) marks.ctx = c.getContext('2d', { willReadFrequently: true });
  }

  function nextColour() {
    var used = {};
    for (var i = 0; i < marks.parts.length; i++) used[marks.parts[i].colour.join()] = 1;
    for (i = 0; i < PALETTE.length; i++) {
      if (!used[PALETTE[i].join()]) return PALETTE[i];
    }
    return PALETTE[marks.parts.length % PALETTE.length];
  }

  function addPart(name) {
    marks.parts.push({ colour: nextColour(), name: name || '', px: 0 });
    marks.active = marks.parts.length - 1;
    buildPartList();
  }

  function removePart(i) {
    var p = marks.parts[i];
    if (!p) return;
    /* Take its paint with it, or the cutter would meet a colour nobody
     * declared and hand those pixels to whichever part is nearest in RGB. */
    eraseColour(p.colour);
    marks.parts.splice(i, 1);
    if (marks.active >= marks.parts.length) marks.active = marks.parts.length - 1;
    countParts();
    buildPartList();
  }

  function eraseColour(colour) {
    if (!marks.ctx) return;
    var c = $('marks');
    var img = marks.ctx.getImageData(0, 0, c.width, c.height);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 129) continue;
      if (nearestPart(d[i], d[i + 1], d[i + 2]) === colourIndex(colour)) {
        d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
      }
    }
    marks.ctx.putImageData(img, 0, 0);
  }

  function colourIndex(colour) {
    for (var i = 0; i < marks.parts.length; i++) {
      if (marks.parts[i].colour.join() === colour.join()) return i;
    }
    return -1;
  }

  /* Which declared part a painted pixel belongs to. Nearest colour, not an
   * exact match: a brush stroke is antialiased, so its rim is a blend and an
   * exact test would throw every rim pixel away. */
  function nearestPart(r, g, b) {
    var best = -1, bestD = 1 << 30;
    for (var i = 0; i < marks.parts.length; i++) {
      var c = marks.parts[i].colour;
      var d = Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function countParts() {
    var c = $('marks');
    if (!marks.ctx || !c.width) return;
    for (var i = 0; i < marks.parts.length; i++) marks.parts[i].px = 0;
    var d = marks.ctx.getImageData(0, 0, c.width, c.height).data;
    for (var k = 0; k < d.length; k += 4) {
      if (d[k + 3] < 129) continue;
      var p = nearestPart(d[k], d[k + 1], d[k + 2]);
      if (p >= 0) marks.parts[p].px++;
    }
  }

  function paintTo(x, y, erase) {
    var g = marks.ctx;
    if (!g || !marks.parts.length) return;
    g.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    g.strokeStyle = g.fillStyle = rgbCss(marks.parts[marks.active].colour);
    g.lineWidth = marks.brush;
    g.lineCap = g.lineJoin = 'round';
    if (marks.last) {
      g.beginPath();
      g.moveTo(marks.last[0], marks.last[1]);
      g.lineTo(x, y);
      g.stroke();
    } else {
      g.beginPath();
      g.arc(x, y, marks.brush / 2, 0, Math.PI * 2);
      g.fill();
    }
    marks.last = [x, y];
  }

  /* Which row is the brush loaded with. Deliberately not a rebuild: the row
   * holds a text field somebody may be typing in, and rebuilding it under a
   * focused field takes the focus with it. Putting the focus back afterwards
   * fires focus again, which rebuilt again - a loop that ended in "Maximum
   * call stack size exceeded" the moment a name field was clicked. */
  function markActive(idx) {
    marks.active = idx;
    var ul = $('partList');
    for (var i = 0; i < ul.children.length; i++) {
      ul.children[i].className = (i === idx ? 'on' : '');
    }
  }

  function buildPartList() {
    var ul = $('partList');
    ul.innerHTML = '';
    for (var i = 0; i < marks.parts.length; i++) {
      (function (p, idx) {
        var li = document.createElement('li');
        li.className = (idx === marks.active ? 'on' : '');

        var sw = document.createElement('span');
        sw.className = 'chip';
        sw.style.background = rgbCss(p.colour);

        var nm = document.createElement('input');
        nm.className = 'txt';
        nm.type = 'text';
        nm.spellcheck = false;
        nm.value = p.name;
        nm.placeholder = 'kopf, arm, hand …';
        nm.setAttribute('list', 'partWords');
        nm.addEventListener('input', function () { p.name = nm.value.trim(); });
        nm.addEventListener('focus', function () { markActive(idx); });

        var px = document.createElement('span');
        px.className = 'pv';
        px.textContent = p.px ? (p.px > 9999 ? Math.round(p.px / 1000) + 'k' : p.px) : '–';

        var kill = document.createElement('button');
        kill.type = 'button';
        kill.className = 'x';
        kill.textContent = '×';
        kill.title = 'remove this part and its paint';
        kill.addEventListener('click', function (e) {
          e.stopPropagation();
          removePart(idx);
        });

        li.appendChild(sw);
        li.appendChild(nm);
        li.appendChild(px);
        li.appendChild(kill);
        li.addEventListener('click', function () { markActive(idx); });
        ul.appendChild(li);
      })(marks.parts[i], i);
    }
  }

  /* Marks that were painted before and are still on disk. Without this the
   * brush started from an empty canvas every time, so an afternoon of
   * marking survived exactly as long as the tab did - and a cut that failed
   * for any reason took the work with it. */
  function loadMarks() {
    var base = FIGURES_ROOT + state.name + '/';
    return fetch(base + 'marks.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (plan) {
        if (!plan || !plan.parts || !plan.parts.length) return false;
        return new Promise(function (res) {
          var img = new Image();
          img.onload = function () {
            var c = $('marks');
            /* A mask drawn on a different canvas is not this figure's mask,
             * whatever the folder says. */
            if (img.naturalWidth !== c.width || img.naturalHeight !== c.height) {
              markSay('marks.png is ' + img.naturalWidth + '×' + img.naturalHeight +
                      ', this figure is ' + c.width + '×' + c.height +
                      '. Left it alone.');
              return res(false);
            }
            marks.ctx.clearRect(0, 0, c.width, c.height);
            marks.ctx.globalCompositeOperation = 'source-over';
            marks.ctx.drawImage(img, 0, 0);
            marks.parts = plan.parts.map(function (p) {
              return { colour: p.colour, name: p.name || '', px: 0 };
            });
            marks.active = 0;
            countParts();
            buildPartList();
            markSay('Picked up the marks that were already there.');
            res(true);
          };
          img.onerror = function () { res(false); };
          img.src = base + 'marks.png?' + Date.now();
        });
      })
      .catch(function () { return false; });
  }

  function setMarkMode(on) {
    marks.on = !!on;
    $('marks').hidden = !marks.on;
    $('markPanel').hidden = !marks.on;
    $('layerList').hidden = marks.on;
    $('layerNote').hidden = marks.on;
    $('brushWrap').hidden = !marks.on;
    $('markBtn').setAttribute('aria-pressed', String(marks.on));
    $('markBtn').className = 'btn' + (marks.on ? ' primary' : '');
    $('overlay').classList.toggle('painting', marks.on);
    if (marks.on) {
      sizeMarks();
      applyView();
      markSay('');
      buildPartList();
      loadMarks().then(function (found) {
        if (!found && !marks.parts.length) { addPart(''); buildPartList(); }
      });
    }
  }

  /* Everything the cutter is promised: flat colours, full alpha, nothing
   * else. The rim of every stroke is a blend, and writing those out as they
   * are would leave marks.png full of colours no part declares. */
  function flatMarksBlob() {
    var c = $('marks');
    var img = marks.ctx.getImageData(0, 0, c.width, c.height);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 129) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; continue; }
      var p = nearestPart(d[i], d[i + 1], d[i + 2]);
      var c3 = marks.parts[p].colour;
      d[i] = c3[0]; d[i + 1] = c3[1]; d[i + 2] = c3[2]; d[i + 3] = 255;
    }
    var out = document.createElement('canvas');
    out.width = c.width; out.height = c.height;
    out.getContext('2d').putImageData(img, 0, 0);
    return new Promise(function (res, rej) {
      out.toBlob(function (b) { b ? res(b) : rej(new Error('marks.png leer')); },
                 'image/png');
    });
  }

  /* A figure that came in through "Flat image" lives only in this page.
   * onDisk() cannot see that - it only checks that the figure has a name,
   * and an unsaved one does - so the cut used to march straight on and fail
   * three requests later against a folder that was never made.
   *
   * Cutting is the first thing that needs a real folder, so this is where
   * one appears. No layers on purpose: the importer reads an empty list as
   * "no rig to keep" and builds one from the parts, which is exactly right
   * for a first cut. */
  function ensureFigureOnDisk() {
    var name = state.name;
    /* state.unsaved holds exactly the figures that live only in this page,
     * so this is an answer rather than a question. Asking the server meant a
     * HEAD that comes back 404 in the normal case, which is a red line in
     * the console for something that is working. */
    return Promise.resolve()
      .then(function () {
        if (!state.unsaved[name]) return;
        var f = state.figure;
        var fig = {
          name: name,
          note: 'Started from a flat picture, cut in the studio.',
          size: f.size || { width: 1000, height: 1000 },
          motion: f.motion || { windowSeconds: 8, followSeconds: 0.085, parallax: 0.25 },
          layers: []
        };
        markSay('creating figures/' + name + ' …');
        return putFile(FIGURES_ROOT + name + '/figure.json',
                       JSON.stringify(fig, null, 2) + '\n', 'application/json')
          .then(function () { return registerFigure(name); })
          .then(function () { delete state.unsaved[name]; });
      });
  }

  /* The flat picture has to be on disk before the cutter can read it. It is
   * already there when flatten.py wrote it or a previous cut ran; it is in
   * the page when the figure came in through "Flat image". */
  function ensureSource() {
    var path = FIGURES_ROOT + state.name + '/source.png';
    /* When the page is holding the picture, write it: it is the one being
     * marked, so an older source.png next to it is the wrong one. Only a
     * figure that came off disk has to be asked. */
    if (marks.sourceFile) return putFile(path, marks.sourceFile, 'image/png');
    return fetch(path, { method: 'HEAD' }).then(function (r) {
      if (!r.ok) {
        throw new Error('figures/' + state.name + '/source.png is missing. ' +
                        'Start from a flat image, or run  python ' +
                        'tools/flatten.py ' + state.name);
      }
    });
  }

  function runCut() {
    if (!state.canWrite) { markSay('The server is read-only.'); return; }
    if (!state.figure || !state.name) {
      markSay('Load a figure first.');
      return;
    }
    if (!NAME_OK.test(state.name)) {
      markSay('"' + state.name + '" cannot be a folder here. A name may hold '
            + 'a-z, 0-9, dot, dash and underscore, and has to start with a '
            + 'letter or a digit.');
      return;
    }
    var named = 0, i;
    for (i = 0; i < marks.parts.length; i++) if (marks.parts[i].name) named++;
    if (named !== marks.parts.length) {
      markSay('Every part needs a name - that is what decides its rig.');
      return;
    }
    countParts();
    for (i = 0; i < marks.parts.length; i++) {
      if (!marks.parts[i].px) {
        markSay('"' + marks.parts[i].name + '" has no paint on it yet.');
        return;
      }
    }

    var name = state.name;
    var count = marks.parts.length;
    var plan = { parts: marks.parts.map(function (p) {
      return { colour: p.colour, name: p.name };
    }) };

    /* The importer keeps an existing rig on purpose - the pivots and the
     * chain are the part a person corrected by hand, and they cannot be
     * recovered from the pixels. That is right when the same parts come back
     * repainted, and wrong the first time, when the rig on file describes
     * one layer called "whole" and the cut just produced eight.
     *
     * So: keep it when the cut produces exactly the layers that are already
     * there, rewrite it when it does not. Comparing the names is the whole
     * test, because the name is what the rig was built from. */
    var have = (state.figure.layers || []).map(function (L) { return L.id; }).sort();
    var want = plan.parts.map(function (p) { return slugLike(p.name); }).sort();
    var same = have.length === want.length && have.every(function (v, i) {
      return v === want[i];
    });
    var rewrite = same ? '' : '&rewrite=1';

    markSay('cutting …');
    ensureFigureOnDisk()
      .then(ensureSource)
      .then(flatMarksBlob)
      .then(function (blob) {
        return putFile(FIGURES_ROOT + name + '/marks.png', blob, 'image/png');
      })
      .then(function () {
        return putFile(FIGURES_ROOT + name + '/marks.json',
                       JSON.stringify(plan, null, 2) + '\n', 'application/json');
      })
      .then(function () {
        /* reach is the setting that decides what a cut even is: small, and
         * the parts follow the brush; large, and the marks divide the whole
         * figure between them with the seams halfway between the blobs. */
        var q = '/_cut?name=' + encodeURIComponent(name) +
                '&grow=' + encodeURIComponent(marks.grow) +
                '&rest=' + ($('keepRest').checked ? 'rest' : '');
        return fetch(q, { method: 'POST' }).then(function (r) { return r.json(); });
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.err || res.error || 'cut failed');
        markSay(res.out || 'cut.');
        /* Same call the parts upload makes. From here the rig comes out of
         * import-layers.py exactly as it does for parts that arrived any
         * other way. */
        return fetch('/_import?name=' + encodeURIComponent(name) + rewrite,
                     { method: 'POST' })
          .then(function (r) { return r.json(); });
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.err || res.error || 'import failed');
        /* The figure may have only just appeared on disk, so the picker has
         * to learn about it before it is mounted from there. */
        return refreshFigureList(name).then(function () { return loadFigure(name); });
      })
      .then(function () {
        setMarkMode(false);
        say('Cut into ' + count + ' parts and ' +
            (rewrite ? 'rigged' : 'refreshed') +
            '. Correct the pivots and the chain in the panel.');
      })
      .catch(function (e) { markSay(String((e && e.message) || e)); });
  }

  /* The words that actually produce a rig, straight from the importer that
   * owns them. The built-in list is a fallback for a read-only server; the
   * agreement test holds it to the real table. */
  var VOCAB_FALLBACK = [
    'eye', 'lens', 'head', 'hair', 'face', 'hat', 'hand', 'finger', 'rifle',
    'gun', 'arm', 'sleeve', 'shoulder', 'chest', 'collar', 'torso', 'coat',
    'cloak', 'cape', 'scarf', 'strap', 'belly', 'leg', 'waist', 'lower'
  ];

  function loadVocab() {
    return fetch('/_vocab')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(0); })
      .then(function (v) {
        var words = [];
        for (var i = 0; i < v.kinds.length; i++) {
          words = words.concat(v.kinds[i].english, v.kinds[i].german);
        }
        return words;
      })
      .catch(function () { return VOCAB_FALLBACK; })
      .then(function (words) {
        var dl = $('partWords');
        dl.innerHTML = '';
        for (var i = 0; i < words.length; i++) {
          var o = document.createElement('option');
          o.value = words[i];
          dl.appendChild(o);
        }
      });
  }

  function bindMarking() {
    $('markBtn').addEventListener('click', function () { setMarkMode(!marks.on); });
    $('addPartBtn').addEventListener('click', function () { addPart(''); });
    $('cutBtn').addEventListener('click', runCut);
    $('brushSize').addEventListener('input', function () {
      marks.brush = parseFloat(this.value);
    });
    $('growPx').addEventListener('input', function () {
      marks.grow = parseFloat(this.value);
      $('growOut').textContent = marks.grow + ' px';
    });
    /* The right button erases, so its menu has to stay shut over the stage. */
    $('overlay').addEventListener('contextmenu', function (e) {
      if (marks.on) e.preventDefault();
    });
    loadVocab();
  }

  /* ================================================================== *
   * Bringing a part in from another picture
   *
   * One picture rarely gives every part at its best. Cut the first for the
   * parts it does well, cut a second for the rest, and put them on one
   * figure. The two pictures are almost never the same size, and the engine
   * has no per-layer scale - every layer is a full-canvas image, and that is
   * what makes the file readable.
   *
   * So the scaling happens here and is baked into the pixels. What ships is
   * an ordinary layer, and idle.js learns nothing new.
   * ================================================================== */

  var place = { img: null, x: 0, y: 0, scale: 1, name: '', from: '' };

  function drawPlace() {
    var c = $('place');
    if (!place.img) { c.hidden = true; return; }
    var f = state.figure;
    var w = (f.size && f.size.width) || 1000;
    var h = (f.size && f.size.height) || 1000;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    c.hidden = false;
    var g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(place.img, place.x, place.y,
                place.img.naturalWidth * place.scale,
                place.img.naturalHeight * place.scale);
    applyView();
  }

  function clearPlace() {
    place.img = null;
    $('place').hidden = true;
    $('placeCtl').hidden = true;
  }

  function addSay(m) { $('addOut').textContent = m || ''; }

  function refreshAddFrom() {
    var sel = $('addFrom');
    var keep = sel.value;
    sel.innerHTML = '';
    var names = [];
    var opts = $('figureSel').options;
    for (var i = 0; i < opts.length; i++) {
      var v = opts[i].value;
      if (v.indexOf(UNSAVED) === 0 || v === state.name) continue;
      names.push(v);
    }
    for (i = 0; i < names.length; i++) {
      var o = document.createElement('option');
      o.value = o.textContent = names[i];
      sel.appendChild(o);
    }
    if (keep && names.indexOf(keep) >= 0) sel.value = keep;
    return loadAddLayers();
  }

  function loadAddLayers() {
    var from = $('addFrom').value;
    var sel = $('addLayer');
    sel.innerHTML = '';
    if (!from) return Promise.resolve();
    return fetch(FIGURES_ROOT + from + '/figure.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (fig) {
        if (!fig) return;
        var ls = fig.layers || [];
        /* Only layers that are one picture. A flip-book is a list of images
         * and there is nothing sensible to place. */
        for (var i = ls.length - 1; i >= 0; i--) {
          if (!ls[i].src) continue;
          var o = document.createElement('option');
          o.value = ls[i].id;
          o.textContent = ls[i].id;
          sel.appendChild(o);
        }
      })
      .catch(function () {});
  }

  /* Everything after the image is loaded is the same whether it came from
   * another figure or off the disk, so both routes end here. */
  function startPlacing(img, name) {
    var f = state.figure;
    var w = (f.size && f.size.width) || 1000;
    var h = (f.size && f.size.height) || 1000;
    place.img = img;
    /* Fit it to this canvas to begin with. A part cut from a 2048 px picture
     * dropped onto a 1000 px figure at one to one is off the edge and looks
     * like nothing happened. */
    place.scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    place.x = (w - img.naturalWidth * place.scale) / 2;
    place.y = (h - img.naturalHeight * place.scale) / 2;
    place.base = place.scale;
    place.name = name;
    $('placeName').value = name;
    $('placeScale').value = '100';
    $('placeScaleVal').textContent = '100';
    $('placeCtl').hidden = false;
    addSay('Drag it on the stage, then press Place.');
    drawPlace();
  }

  function bringInFile(file) {
    if (!state.figure) { addSay('Load a figure first.'); return; }
    var url = URL.createObjectURL(file);
    loadImg(url)
      .then(function (img) {
        startPlacing(img, figureName(file.name.replace(/\.[^.]+$/, '')) || 'teil');
      })
      .catch(function (e) { addSay(String((e && e.message) || e)); });
  }

  function bringIn() {
    var from = $('addFrom').value, id = $('addLayer').value;
    if (!from || !id) { addSay('Pick a figure and a layer.'); return; }
    if (!state.figure) { addSay('Load a figure first.'); return; }

    addSay('loading …');
    fetch(FIGURES_ROOT + from + '/figure.json')
      .then(function (r) { return r.json(); })
      .then(function (fig) {
        var L = (fig.layers || []).filter(function (x) { return x.id === id; })[0];
        if (!L || !L.src) throw new Error('layer ' + id + ' has no image');
        return loadImg(FIGURES_ROOT + from + '/' + L.src);
      })
      .then(function (img) {
        place.from = from;
        startPlacing(img, id);
      })
      .catch(function (e) { addSay(String((e && e.message) || e)); });
  }

  /* The next free number in the figure folder, so a placed part lands behind
   * everything that is already there rather than on top of a file that
   * exists. The studio moves it to the front afterwards - the draw order is
   * a decision, the file name is only a sort key. */
  function nextPartNumber(name) {
    return figureFiles(name).then(function (d) {
      var max = 0;
      for (var i = 0; i < d.files.length; i++) {
        var m = /^(\d\d)-/.exec(d.files[i]);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      return Math.min(max + 1, 99);
    });
  }

  function doPlace() {
    if (!place.img) return;
    var nm = ($('placeName').value || '').trim();
    if (!nm) { addSay('The part needs a name - that is its rig.'); return; }
    if (!state.canWrite || !state.name) { addSay('No writable figure.'); return; }

    var name = state.name;
    var slug = slugLike(nm);
    addSay('placing …');

    nextPartNumber(name)
      .then(function (n) {
        var file = (n < 10 ? '0' + n : String(n)) + '-' + slug + '.png';
        /* The canvas already holds the part at exactly the size and place it
         * was given, on this figure's canvas. Baking is therefore not a
         * separate step - it is what has been on screen the whole time. */
        return canvasToU8($('place'), 'image/png').then(function (u8) {
          return putFile(FIGURES_ROOT + name + '/' + file,
                         new Blob([u8], { type: 'image/png' }), 'image/png');
        });
      })
      .then(function () {
        return fetch('/_import?name=' + encodeURIComponent(name), { method: 'POST' })
          .then(function (r) { return r.json(); });
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.err || res.error || 'import failed');
        return loadFigure(name);
      })
      .then(function () {
        /* It arrived at the back, because that is where its file name put
         * it. A part somebody just placed wants to be visible. */
        var layers = state.figure.layers || [];
        for (var i = 0; i < layers.length; i++) {
          if (layers[i].id === slug && i !== layers.length - 1) {
            layers.push(layers.splice(i, 1)[0]);
            break;
          }
        }
        state.selected = slug;
        restack();
        buildLayerList();
        buildLayerCard();
        buildMotionControls();
        clearPlace();
        return saveFigure();
      })
      .then(function () {
        addSay('Placed as "' + slug + '". Give it a parent in the Layer card.');
      })
      .catch(function (e) { addSay(String((e && e.message) || e)); });
  }

  function bindPlacing() {
    $('addFrom').addEventListener('change', loadAddLayers);
    $('addFetch').addEventListener('click', bringIn);
    $('addFile').addEventListener('change', function () {
      if (this.files && this.files.length) bringInFile(this.files[0]);
      this.value = '';
    });
    $('placeCancel').addEventListener('click', function () {
      clearPlace();
      addSay('');
    });
    $('placeDo').addEventListener('click', doPlace);
    $('placeScale').addEventListener('input', function () {
      var pct = parseFloat(this.value);
      $('placeScaleVal').textContent = String(Math.round(pct));
      if (!place.img) return;
      var f = state.figure;
      var w = (f.size && f.size.width) || 1000;
      var h = (f.size && f.size.height) || 1000;
      /* Scale about the middle of what is on screen, so the part does not
       * walk off the canvas as it grows. */
      var cx = place.x + place.img.naturalWidth * place.scale / 2;
      var cy = place.y + place.img.naturalHeight * place.scale / 2;
      place.scale = place.base * pct / 100;
      place.x = cx - place.img.naturalWidth * place.scale / 2;
      place.y = cy - place.img.naturalHeight * place.scale / 2;
      drawPlace();
    });
  }

  /* ================================================================== *
   * The shell: two rails that fold, resize and trade sides
   *
   * Kept in localStorage, not in the figure. Which side someone wants their
   * layers on is a property of the person, not of the character - a panel
   * width in figure.json would turn up in the diff of every commit and mean
   * nothing to anyone reading it.
   * ================================================================== */

  var LAYOUT_KEY = 'idle-studio-layout';
  var RAIL_MIN = 220;
  var RAIL_MAX = 620;

  var layout = { left: 300, right: 360, swapped: false, showL: true, showR: true };

  function clampRail(n, fallback) {
    n = Math.round(Number(n));
    if (!isFinite(n)) return fallback;
    return Math.max(RAIL_MIN, Math.min(RAIL_MAX, n));
  }

  function readLayout() {
    /* Any of this can throw or come back as junk: a private window, a value
     * written by an older build, storage switched off entirely. None of that
     * is worth a broken studio, so every field falls back on its own. */
    try {
      var raw = window.localStorage.getItem(LAYOUT_KEY);
      if (!raw) return;
      var j = JSON.parse(raw);
      if (!j || typeof j !== 'object') return;
      layout.left = clampRail(j.left, layout.left);
      layout.right = clampRail(j.right, layout.right);
      layout.swapped = !!j.swapped;
      layout.showL = j.showL !== false;
      layout.showR = j.showR !== false;
    } catch (e) { /* keep the defaults */ }
  }

  function writeLayout() {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch (e) { /* nothing to do about it, and nothing is lost */ }
  }

  function flag(el, name, on) {
    if (on) el.classList.add(name); else el.classList.remove(name);
  }

  function applyLayout() {
    var sh = $('shell');
    sh.style.setProperty('--rail-l', layout.left + 'px');
    sh.style.setProperty('--rail-r', layout.right + 'px');
    flag(sh, 'swapped', layout.swapped);
    flag(sh, 'no-l', !layout.showL);
    flag(sh, 'no-r', !layout.showR);
    $('toggleL').setAttribute('aria-pressed', String(layout.showL));
    $('toggleR').setAttribute('aria-pressed', String(layout.showR));
  }

  function setRail(which, px) {
    if (which === 'left') layout.left = clampRail(px, layout.left);
    else layout.right = clampRail(px, layout.right);
    applyLayout();
    writeLayout();
  }

  function bindGrip(id, which) {
    var g = $(id);
    var startX = 0, startW = 0, sign = 1, live = false;

    /* Which way the pointer has to travel to make a rail wider depends on
     * which side that rail is currently on, and the swap moves it. Worked
     * out once at mousedown rather than read on every move. */
    function direction() {
      return (which === 'left' ? 1 : -1) * (layout.swapped ? -1 : 1);
    }

    g.addEventListener('mousedown', function (e) {
      live = true;
      startX = e.clientX;
      startW = (which === 'left') ? layout.left : layout.right;
      sign = direction();
      g.classList.add('on');
      document.body.classList.add('dragging-rail');
      /* Or the browser starts selecting the text either side of the grip. */
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (!live) return;
      setRail(which, startW + (e.clientX - startX) * sign);
    });

    window.addEventListener('mouseup', function () {
      if (!live) return;
      live = false;
      g.classList.remove('on');
      document.body.classList.remove('dragging-rail');
    });

    /* A separator that can only be dragged is one that cannot be reached
     * from the keyboard at all. */
    g.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 64 : 16;
      var d = 0;
      if (e.key === 'ArrowLeft') d = -step;
      else if (e.key === 'ArrowRight') d = step;
      else return;
      e.preventDefault();
      var now = (which === 'left') ? layout.left : layout.right;
      setRail(which, now + d * direction());
    });
  }

  function bindShell() {
    readLayout();
    applyLayout();

    $('toggleL').addEventListener('click', function () {
      layout.showL = !layout.showL;
      applyLayout();
      writeLayout();
    });
    $('toggleR').addEventListener('click', function () {
      layout.showR = !layout.showR;
      applyLayout();
      writeLayout();
    });
    $('swapBtn').addEventListener('click', function () {
      layout.swapped = !layout.swapped;
      applyLayout();
      writeLayout();
    });

    bindGrip('gripL', 'left');
    bindGrip('gripR', 'right');

    /* Folding, dragging and the window all change the same thing - how much
     * room the stage has - so one observer answers for all three instead of
     * three call sites that have to remember. */
    if (window.ResizeObserver) {
      new ResizeObserver(refitStage).observe($('stage').parentNode);
    }
  }

  function boot() {
    bindShell();
    bindMarking();
    bindPlacing();
    bindPivotDrag();
    bindNudgeKeys();
    bindUndo();

    /* Pointer tracking is bound once, to the overlay, and forwarded to
     * whichever figure is mounted. Calling figure.trackPointer() on every
     * switch would stack a fresh listener per figure, each still writing into
     * a figure nobody can see any more. */
    (function () {
      var ov = $('overlay');
      ov.addEventListener('mousemove', function (e) {
        if (!state.fig) return;
        var r = ov.getBoundingClientRect();
        state.fig.pointerX = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
        state.fig.pointerY = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      });
      ov.addEventListener('mouseleave', function () {
        if (!state.fig) return;
        state.fig.pointerX = 0;
        state.fig.pointerY = 0;
      });
    })();

    $('playBtn').addEventListener('click', function () {
      if (!state.fig) return;
      if (state.fig.playing) { state.fig.pause(); this.textContent = 'Play'; }
      else { state.fig.play(); this.textContent = 'Pause'; }
    });

    $('scrub').addEventListener('input', function () {
      if (!state.fig) return;
      state.fig.seek(parseFloat(this.value));
      $('playBtn').textContent = 'Play';
      drawOverlay();
    });

    $('showPivots').addEventListener('change', drawOverlay);

    /* Layer edges: paint every layer in a flat colour. A part cut to its own
     * shape looks like the thing it is; a part cut to a bounding box looks
     * like a rectangle, and a rectangle's straight edge is what shows as a
     * seam once it moves. Measured on the priest: the chest layer's box edge
     * deviates 8.4 of 255 from the original against 3.0 twenty pixels
     * inside it. */
    $('showSeams').addEventListener('change', function () {
      var on = this.checked;
      var boxes = document.querySelectorAll('.idle-layer');
      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i];
        var im = box.getElementsByTagName('img');
        var visible = null;
        for (var k = 0; k < im.length; k++) {
          /* Which picture is actually on screen right now - idle.js toggles
           * `visibility`, never `display`, so a layer with more than one
           * <img> (a frames layer, or one with mood pictures) used to have
           * this pick the LAST node every time regardless of which one was
           * shown, because style.display stays '' on every one of them. */
          if (im[k].style.visibility !== 'hidden') visible = im[k];
          im[k].style.visibility = on ? 'hidden' : '';
        }
        if (on && visible) {
          /* The image itself becomes a mask over a flat colour, so what you
           * see is the exact silhouette the cut produced - nothing else. */
          var url = 'url("' + visible.getAttribute('src') + '")';
          box.style.backgroundColor = SEAM_COLORS[i % SEAM_COLORS.length];
          box.style.webkitMaskImage = url;
          box.style.maskImage = url;
          box.style.webkitMaskSize = '100% 100%';
          box.style.maskSize = '100% 100%';
          /* Deliberately not opacity: render() rewrites that every frame from
           * the solved state, so anything set here is gone within 16 ms. */
        } else {
          box.style.backgroundColor = '';
          box.style.webkitMaskImage = '';
          box.style.maskImage = '';
        }
      }
    });


    (function () {
      var sws = document.querySelectorAll('.swatches .sw[data-bg]');
      for (var i = 0; i < sws.length; i++) {
        (function (b) {
          b.addEventListener('click', function () {
            setStageBg(b.getAttribute('data-bg'), b);
          });
        })(sws[i]);
      }
      $('bgPick').addEventListener('input', function () {
        setStageBg(this.value, this);
      });
    })();

    $('newImage').addEventListener('change', function () {
      if (this.files && this.files[0]) newFromImage(this.files[0]).catch(showError);
      this.value = '';
    });


    $('loopWindow').addEventListener('change', function () {
      if (state.fig) state.fig.loop = this.checked ? state.window : 0;
    });

    $('figureSel').addEventListener('change', function () {
      /* Loading another figure replaces this one, edits and undo history
       * with it. A figure that only lives in this page keeps its edits in
       * state.unsaved, so only one that came off the disk can lose them. */
      if (onDisk() && isDirty() && !window.confirm(
          'Throw the unsaved changes to "' + state.name + '" away?')) {
        this.value = state.name;
        return;
      }
      if (this.value.indexOf(UNSAVED) === 0) {
        var u = state.unsaved[this.value.slice(UNSAVED.length)];
        if (u) mountFigure(u.name, u, '');
        return;
      }
      loadFigure(this.value).catch(showError);
    });

    $('zoomFit').addEventListener('click', resetView);

    $('sheetBtn').addEventListener('click', buildSheet);

    $('eventsBtn').addEventListener('click', renderEvents);

    $('sheetSave').addEventListener('click', function () {
      var c = $('sheet');
      if (!c.width) buildSheet();
      /* buildSheet bails out while the images are still loading, so the
       * canvas can still be 0 wide here - and toBlob then hands back null,
       * which made URL.createObjectURL throw. */
      if (!c.width || !c.height) {
        $('exportOut').textContent = 'Bilder sind noch nicht geladen.';
        return;
      }
      c.toBlob(function (b) {
        if (!b) { $('exportOut').textContent = 'Bilderstreifen leer.'; return; }
        var url = URL.createObjectURL(b);
        var a = document.createElement('a');
        a.href = url;
        a.download = state.name + '-contact-sheet.png';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      }, 'image/png');
    });

    $('exportBtn').addEventListener('click', exportFigure);

    $('iouFile').addEventListener('change', function () {
      if (this.files && this.files.length) runIou(this.files);
    });

    $('jsonBtn').addEventListener('click', function () {
      $('jsonOut').value = JSON.stringify(state.figure, null, 2);
    });

    /* The way out when a knob is missing. Everything the panel offers is
     * guarded field by field; typed JSON goes around all of it, so the same
     * guard has to stand here too - and a parent loop is the one mistake the
     * player cannot survive, because it walks the chain on every frame. */
    $('jsonApply').addEventListener('click', function () {
      var msg = $('jsonMsg');
      var txt = $('jsonOut').value;
      /* Without a figure there is no base URL, so every src would resolve
       * against the studio's own folder and load nothing. */
      if (!state.figure) {
        msg.textContent = 'Load or create a figure first.';
        return;
      }
      if (!txt.replace(/\s/g, '')) {
        msg.textContent = 'The box is empty. Press "Show current" first.';
        return;
      }

      var fig;
      try {
        fig = JSON.parse(txt);
      } catch (e) {
        msg.textContent = 'Refused, not JSON: ' + ((e && e.message) || e);
        return;
      }

      var bad = figureTrouble(fig);
      if (bad) {
        msg.textContent = 'Refused: ' + bad + '. Nothing changed.';
        return;
      }

      msg.textContent = 'Applied. Not saved - press Save for that.';
      mountFigure(state.name, fig, state.base, true)
        .catch(function (e) {
          /* The figure is mounted either way; this is only about the images
           * the canvas work needs, so say which one and carry on. */
          msg.textContent = 'Applied, but an image is missing: ' +
                            ((e && e.message) || e);
        });
    });

    $('jsonCopy').addEventListener('click', function () {
      var ta = $('jsonOut');
      if (!ta.value) ta.value = JSON.stringify(state.figure, null, 2);
      ta.select();
      document.execCommand('copy');
      this.textContent = 'Copied';
      var self = this;
      setTimeout(function () { self.textContent = 'Copy'; }, 1200);
    });

    window.addEventListener('resize', refitStage);

    $('newFigureBtn').addEventListener('click', createFigure);
    $('newName').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') createFigure();
    });
    $('saveBtn').addEventListener('click', function () {
      saveFigure().catch(function (e) { say(String((e && e.message) || e)); });
    });
    $('resetBtn').addEventListener('click', resetFigure);
    armDangerButton($('deleteFigureBtn'), 'Delete figure',
      function () { return 'Really delete "' + state.name + '" and everything in it?'; },
      deleteFigure);
    $('partsInput').addEventListener('change', function () {
      if (this.files && this.files.length) uploadParts(this.files);
      this.value = '';
    });

    /* Dirtiness is worked out by serialising the figure, which is cheap but
     * not free. Twice a second is well under what anyone notices and does not
     * put a JSON.stringify inside the animation loop. */
    window.setInterval(function () {
      /* The safety net for undo: an edit that arrived without a pointer,
       * key or change event behind it still becomes a step. */
      checkpoint();
      refreshSaveState();
    }, 500);

    probeServer();

    refreshFigureList().catch(function (e) {
      document.body.insertAdjacentHTML('afterbegin',
        '<p style="padding:16px;color:#e06c75">' + e.message + '</p>');
    });

    requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
