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
    window: 8,
    stageBg: null,  /* null = transparent, else a css colour */
    unsaved: {}     /* figures that live only in this page, by name */
  };

  /* ================================================================== *
   * Figure discovery
   * ================================================================== */

  function listFigures() {
    return fetch(FIGURES_ROOT + 'index.json')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(0); })
      .catch(function () {
        /* python -m http.server serves a directory listing. Parse it. */
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

  function mountFigure(name, fig, base) {
    state.name = name;
    state.figure = fig;
    state.base = base;
    state.selected = null;
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

    buildLayerList();
    buildMotionControls();
    buildIouTruthList();
    sizeOverlay();
    $('sheet').width = 0;
    $('eventsOut').textContent = '';
    $('iouTable').innerHTML = '';

    state.images = null;
    return Idle.loadImages(fig, base).then(function (imgs) { state.images = imgs; });
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
    var url = URL.createObjectURL(file);
    return loadImg(url).then(function (img) {
      var name = file.name.replace(/\.[^.]+$/, '') || 'figure';
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
   * Layer list and selection
   * ================================================================== */

  function buildLayerList() {
    var ul = $('layerList');
    ul.innerHTML = '';
    var layers = state.figure.layers || [];
    /* Draw order is back to front. Read it top to bottom as front to back,
     * the way a layer palette does. */
    for (var i = layers.length - 1; i >= 0; i--) {
      (function (L) {
        var li = document.createElement('li');
        if (L.id === state.selected) li.className = 'on';

        var nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = L.id;

        var tags = document.createElement('span');
        tags.className = 'tags';
        tags.textContent = (L.motions || []).map(function (m) { return m.type; }).join(' ');

        var pv = document.createElement('span');
        pv.className = 'pv';
        var p = L.pivot || [0.5, 0.5];
        pv.textContent = p[0].toFixed(2) + ' / ' + p[1].toFixed(2);

        li.appendChild(nm);
        li.appendChild(tags);
        li.appendChild(pv);
        li.addEventListener('click', function () {
          state.selected = L.id;
          buildLayerList();
          buildMotionControls();
        });
        ul.appendChild(li);
      })(layers[i]);
    }
  }

  function selectedLayer() {
    var layers = state.figure ? (state.figure.layers || []) : [];
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].id === state.selected) return layers[i];
    }
    return null;
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
    grow:       [0, 0.3, 0.005]
  };

  function slider(label, value, onChange, key) {
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
                brightness: 0.6, grow: 0.02 }
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

    /* Layer-level values first: how deep it sits, how far it lags. */
    var g0 = document.createElement('div');
    g0.className = 'grp';
    var h0 = document.createElement('h3');
    h0.textContent = L.id;
    var sp = document.createElement('span');
    sp.textContent = L.parent ? ('  child of ' + L.parent) : '  root';
    h0.appendChild(sp);
    g0.appendChild(h0);
    g0.appendChild(slider('depth', L.depth != null ? L.depth : 0,
      function (v) { L.depth = v; }, 'depth'));
    g0.appendChild(slider('extra lag', L.lag || 0,
      function (v) { L.lag = v; }, 'lag'));
    box.appendChild(g0);

    var ms = L.motions || [];
    for (var i = 0; i < ms.length; i++) {
      (function (m) {
        var g = document.createElement('div');
        g.className = 'grp';
        var h = document.createElement('h3');
        h.textContent = m.type;
        if (m.mode) {
          var s = document.createElement('span');
          s.textContent = '  ' + m.mode;
          h.appendChild(s);
        }
        g.appendChild(h);

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
            var val = (typeof m[key] === 'number') ? m[key] : known[key];
            var label = isRead ? key : key + ' (ignored)';
            g.appendChild(slider(label, val, function (v) { m[key] = v; }, key));
          })(keys[q]);
        }
        box.appendChild(g);
      })(ms[i]);
    }

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
      drawOverlay();
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

  /* Stage pixel (0..w, 0..h) to overlay pixel. */
  function stageToOverlay(px, py) {
    var host = $('stage');
    var r = host.getBoundingClientRect();
    var f = state.figure;
    var w = (f.size && f.size.width) || 1000;
    var h = (f.size && f.size.height) || 1000;
    var k = Math.min(r.width / w, r.height / h);
    var dpr = window.devicePixelRatio || 1;
    return [
      (r.width / 2 + (px - w / 2) * k) * dpr,
      (r.height / 2 + (py - h / 2) * k) * dpr
    ];
  }

  function overlayToStage(cx, cy) {
    var host = $('stage');
    var r = host.getBoundingClientRect();
    var f = state.figure;
    var w = (f.size && f.size.width) || 1000;
    var h = (f.size && f.size.height) || 1000;
    var k = Math.min(r.width / w, r.height / h);
    var dpr = window.devicePixelRatio || 1;
    return [
      (cx / dpr - r.width / 2) / k + w / 2,
      (cy / dpr - r.height / 2) / k + h / 2
    ];
  }

  function drawOverlay() {
    var c = $('overlay');
    var g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    if (!state.figure || !$('showPivots').checked) return;

    var f = state.figure;
    var w = (f.size && f.size.width) || 1000;
    var h = (f.size && f.size.height) || 1000;
    var layers = f.layers || [];

    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var p = L.pivot || [0.5, 0.5];
      var xy = stageToOverlay(p[0] * w, p[1] * h);
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
        g.fillText(L.id + '  ' + p[0].toFixed(3) + ' / ' + p[1].toFixed(3),
                   xy[0] + 14, xy[1] - 12);
      }
    }
  }

  function bindPivotDrag() {
    var c = $('overlay');

    function nearestPivot(cx, cy) {
      var f = state.figure;
      if (!f) return null;
      var w = (f.size && f.size.width) || 1000;
      var h = (f.size && f.size.height) || 1000;
      var best = null, bestD = 1e9;
      var layers = f.layers || [];
      for (var i = 0; i < layers.length; i++) {
        var p = layers[i].pivot || [0.5, 0.5];
        var xy = stageToOverlay(p[0] * w, p[1] * h);
        var d = Math.hypot(xy[0] - cx, xy[1] - cy);
        if (d < bestD) { bestD = d; best = layers[i]; }
      }
      return bestD < 26 * (window.devicePixelRatio || 1) ? best : null;
    }

    function pos(e) {
      var r = c.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
    }

    c.addEventListener('mousedown', function (e) {
      var p = pos(e);
      var L = nearestPivot(p[0], p[1]);
      if (L) {
        state.selected = L.id;
        state.dragging = true;
        buildLayerList();
        buildMotionControls();
        e.preventDefault();
      }
    });

    window.addEventListener('mousemove', function (e) {
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

    window.addEventListener('mouseup', function () { state.dragging = false; });
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
        background: false
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
    var i, j;

    for (i = 0; i < layers.length; i++) {
      var L = layers[i];
      var ms = L.motions || [];
      for (j = 0; j < ms.length; j++) {
        if (ms[j].type === 'blink') watch.push({ id: L.id, kind: 'blink' });
        if (ms[j].type === 'flipbook' && ms[j].mode === 'burst') {
          watch.push({ id: L.id, kind: 'burst' });
        }
      }
    }
    if (!watch.length) return { events: [], watched: [] };

    var open = {}, events = [];
    var n = Math.round(seconds * fps);
    /* Strictly less than n: sampling t = 0 ... 30.000 inclusive reported a
     * fourth burst "in 30 s" with a duration of 0 ms, which then poisoned
     * the min of the range. */
    for (i = 0; i < n; i++) {
      var t = i / fps;
      var st = Idle.solve(f, t, { pointerX: 0, pointerY: 0 });
      var by = {};
      for (j = 0; j < st.length; j++) by[st[j].id] = st[j];

      for (j = 0; j < watch.length; j++) {
        var w = watch[j];
        var s = by[w.id];
        var on = w.kind === 'blink' ? !!s.hidden : (s.frame >= 0);
        var key = w.id + '|' + w.kind;
        if (on && !open[key]) open[key] = { id: w.id, kind: w.kind, a: t, b: t };
        else if (on) open[key].b = t;
        else if (open[key]) { events.push(open[key]); open[key] = null; }
      }
    }
    for (var k in open) { if (open[k]) events.push(open[k]); }
    events.sort(function (a, b) { return a.a - b.a; });
    return { events: events, watched: watch, seconds: seconds };
  }

  function renderEvents() {
    var box = $('eventsOut');
    var r = scanEvents(30, 60);
    if (!r.watched.length) {
      box.textContent = 'No blink and no burst in this figure.';
      return;
    }
    var byId = {};
    for (var i = 0; i < r.events.length; i++) {
      var e = r.events[i];
      var k = e.id + ' ' + e.kind;
      if (!byId[k]) byId[k] = [];
      byId[k].push(e);
    }
    var lines = [];
    if (!r.events.length) {
      var names = r.watched.map(function (w) { return w.id + ' ' + w.kind; }).join(', ');
      box.textContent = 'Watched ' + names + ' over ' + r.seconds +
        ' s and nothing fired.\n' +
        'A blink only hides a layer that carries role "eyesOpen", on it or on ' +
        'an ancestor.';
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

    var jobs = [];
    var files = [];
    var seen = {};
    var renamed = {};
    var base = state.base || '';

    function addImage(path, img) {
      if (seen[path]) return;
      seen[path] = 1;

      /* At master size, copy the original bytes. Re-encoding an already
       * lossy WebP through a canvas at 0.92 loses a generation for nothing,
       * and it also wrote WebP bytes under a .png name. */
      if (scale === 1) {
        jobs.push(fetch(Idle.resolveSrc(src, base, path))
          .then(function (r) {
            if (!r.ok) throw new Error(path + ': ' + r.status);
            return r.arrayBuffer();
          })
          .then(function (ab) { files.push({ name: path, data: new Uint8Array(ab) }); }));
        return;
      }

      var cw = Math.max(1, Math.round(img.naturalWidth * scale));
      var chh = Math.max(1, Math.round(img.naturalHeight * scale));
      var cv = document.createElement('canvas');
      cv.width = cw; cv.height = chh;
      var g = cv.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, cw, chh);
      /* Below master everything becomes WebP, so the path has to say so. */
      var out8 = path.replace(/\.[^.\/]+$/, '.webp');
      jobs.push(canvasToU8(cv, 'image/webp', 0.92).then(function (u8) {
        files.push({ name: out8, data: u8 });
        if (out8 !== path) renamed[path] = out8;
      }));
    }

    if (src.background && state.images._bg) addImage(src.background, state.images._bg);
    var layers = src.layers || [];
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var srcs = (L.frames && L.frames.length) ? L.frames : [L.src];
      var bank = state.images[L.id] || [];
      for (var k = 0; k < srcs.length; k++) {
        if (bank[k]) addImage(srcs[k], bank[k]);
      }
    }

    if (target) {
      /* The player defaults a missing size to 1000, so the export has to use
       * the same default. Falling back to the width instead was wrong by 20%
       * on an 800x1000 figure, and reading src.size.height when there is no
       * size at all threw. */
      f.size = { width: target, height: Math.round(h * scale) };
    }
    delete f.sources;
    /* Keep the JSON pointing at the names actually written. */
    if (f.background && renamed[f.background]) f.background = renamed[f.background];
    for (var q = 0; q < (f.layers || []).length; q++) {
      var FL = f.layers[q];
      if (FL.src && renamed[FL.src]) FL.src = renamed[FL.src];
      if (FL.frames) {
        for (var r2 = 0; r2 < FL.frames.length; r2++) {
          if (renamed[FL.frames[r2]]) FL.frames[r2] = renamed[FL.frames[r2]];
        }
      }
    }

    Promise.all(jobs).then(function () {
      var enc = new TextEncoder();
      files.push({ name: 'figure.json', data: enc.encode(JSON.stringify(f, null, 2)) });
      files.push({ name: 'idle.js', data: null });
      files.pop();  /* the player is shipped once, not per figure */
      var blob = makeZip(files);
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = state.name + (target ? '-' + target : '-master') + '.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      out.textContent = files.length + ' files, ' + Math.round(blob.size / 1024) + ' KB';
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
    var layers = state.figure.layers || [];
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

  function boot() {
    bindPivotDrag();

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
          if (im[k].style.display !== 'none') visible = im[k];
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
      if (this.value.indexOf(UNSAVED) === 0) {
        var u = state.unsaved[this.value.slice(UNSAVED.length)];
        if (u) mountFigure(u.name, u, '');
        return;
      }
      loadFigure(this.value).catch(showError);
    });

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

    $('jsonCopy').addEventListener('click', function () {
      var ta = $('jsonOut');
      if (!ta.value) ta.value = JSON.stringify(state.figure, null, 2);
      ta.select();
      document.execCommand('copy');
      this.textContent = 'Copied';
      var self = this;
      setTimeout(function () { self.textContent = 'Copy'; }, 1200);
    });

    window.addEventListener('resize', function () {
      if (state.fig) state.fig.fit();
      sizeOverlay();
      drawOverlay();
    });

    listFigures().then(function (names) {
      var sel = $('figureSel');
      sel.innerHTML = '';
      for (var i = 0; i < names.length; i++) {
        var o = document.createElement('option');
        o.value = names[i];
        o.textContent = names[i];
        sel.appendChild(o);
      }
      if (names.length) return loadFigure(names[0]);
      document.body.insertAdjacentHTML('afterbegin',
        '<p style="padding:16px;color:#e06c75">No figures found under ' +
        FIGURES_ROOT + '</p>');
    }).catch(function (e) {
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
