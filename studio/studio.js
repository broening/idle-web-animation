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

  var state = {
    name: null,
    figure: null,
    fig: null,          /* the mounted IdleFigure */
    images: null,       /* preloaded Image bank, for canvas work */
    selected: null,     /* layer id */
    dragging: false,
    window: 8
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

  function loadFigure(name) {
    var base = FIGURES_ROOT + name + '/';
    return fetch(base + 'figure.json')
      .then(function (r) {
        if (!r.ok) throw new Error('no figure.json in ' + name);
        return r.json();
      })
      .then(function (fig) {
        state.name = name;
        state.figure = fig;
        state.window = (fig.motion && fig.motion.windowSeconds) || 8;
        $('scrub').max = String(state.window);

        if (state.fig) state.fig.pause();
        state.fig = new Idle.IdleFigure($('stage'), fig, base);
        state.fig.loop = $('loopWindow').checked ? state.window : 0;
        state.fig.trackPointer($('overlay'));
        state.fig.play();
        $('playBtn').textContent = 'Pause';

        buildLayerList();
        buildMotionControls();
        buildIouTruthList();
        sizeOverlay();
        return Idle.loadImages(fig, base);
      })
      .then(function (imgs) { state.images = imgs; });
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
    lag:        [0, 1, 0.005]
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
        for (var k in m) {
          if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
          if (k === 'type' || k === 'mode') continue;
          if (typeof m[k] !== 'number') continue;
          (function (key) {
            g.appendChild(slider(key, m[key], function (v) { m[key] = v; }, key));
          })(k);
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

  var SHEET_COLS = 6, SHEET_ROWS = 4, SHEET_CELL = 260;

  function buildSheet() {
    if (!state.images) return;
    var c = $('sheet');
    c.width = SHEET_COLS * SHEET_CELL;
    c.height = SHEET_ROWS * SHEET_CELL;
    var g = c.getContext('2d');
    g.fillStyle = '#0e1013';
    g.fillRect(0, 0, c.width, c.height);

    var tmp = document.createElement('canvas');
    tmp.width = SHEET_CELL; tmp.height = SHEET_CELL;
    var tg = tmp.getContext('2d');

    var n = SHEET_COLS * SHEET_ROWS;
    for (var i = 0; i < n; i++) {
      var t = (i / n) * state.window;
      Idle.drawFrame(tg, state.figure, state.images, t, {
        width: SHEET_CELL, height: SHEET_CELL,
        background: $('showBg').checked
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
    for (i = 0; i <= n; i++) {
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

      var lh = new Uint8Array(30 + nameU8.length);
      var v = new DataView(lh.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 0, true);
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
      w.setUint16(8, 0, true);
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
    return new Promise(function (res) {
      canvas.toBlob(function (b) {
        b.arrayBuffer().then(function (ab) { res(new Uint8Array(ab)); });
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
    var scale = target ? target / w : 1;

    var jobs = [];
    var files = [];
    var seen = {};

    function addImage(path, img) {
      if (seen[path]) return;
      seen[path] = 1;
      var cw = Math.max(1, Math.round(img.naturalWidth * scale));
      var chh = Math.max(1, Math.round(img.naturalHeight * scale));
      var cv = document.createElement('canvas');
      cv.width = cw; cv.height = chh;
      var g = cv.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, cw, chh);
      jobs.push(canvasToU8(cv, 'image/webp', 0.92).then(function (u8) {
        files.push({ name: path, data: u8 });
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

    if (target) { f.size = { width: target, height: Math.round((src.size.height || w) * scale) }; }

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

  function alphaMask(img, size) {
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, size, size);
    var d = g.getImageData(0, 0, size, size).data;
    var m = new Uint8Array(size * size);
    for (var i = 0, j = 3; i < m.length; i++, j += 4) m[i] = d[j] > 8 ? 1 : 0;
    return m;
  }

  function iou(a, b) {
    var inter = 0, uni = 0;
    for (var i = 0; i < a.length; i++) {
      var x = a[i], y = b[i];
      if (x & y) inter++;
      if (x | y) uni++;
    }
    return uni ? inter / uni : 1;
  }

  function loadImg(url) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = rej;
      im.src = url;
    });
  }

  /* Every image file the figure references, once. */
  function truthPaths() {
    var layers = state.figure.layers || [];
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

  function runIou(fileList) {
    var table = $('iouTable');
    table.innerHTML = '';
    var base = FIGURES_ROOT + state.name + '/';
    var chosen = $('iouTruth').value;
    var auto = $('iouAuto').checked;
    var SIZE = 512;   /* plenty for a shape comparison, and fast */

    var rows = [];
    var all = truthPaths();

    /* Load every truth mask once. With auto-match each uploaded file is
     * compared against all of them, so caching turns an N x M problem back
     * into N + M loads. */
    var truthMasks = Promise.all(all.map(function (p) {
      return loadImg(base + p).then(function (im) {
        return { path: p, mask: alphaMask(im, SIZE) };
      }).catch(function () { return null; });
    })).then(function (list) { return list.filter(Boolean); });

    var jobs = [];
    for (var i = 0; i < fileList.length; i++) {
      (function (file) {
        /* Match by filename when it lines up. The layerize models name their
         * own output, so that usually fails - then auto-match wins, or the
         * dropdown decides. */
        var stem = file.name.replace(/\.[^.]+$/, '').toLowerCase();
        var named = null;
        for (var j = 0; j < all.length; j++) {
          var ls = all[j].replace(/^layers\//, '').replace(/\.[^.]+$/, '').toLowerCase();
          if (ls === stem) named = all[j];
        }

        var url = URL.createObjectURL(file);
        jobs.push(Promise.all([loadImg(url), truthMasks])
          .then(function (pair) {
            var mine = alphaMask(pair[0], SIZE);
            var masks = pair[1];
            URL.revokeObjectURL(url);

            if (!auto && (named || chosen)) {
              var want = named || chosen;
              for (var m = 0; m < masks.length; m++) {
                if (masks[m].path === want) {
                  rows.push({ name: file.name, truth: want, v: iou(mine, masks[m].mask) });
                  return;
                }
              }
            }
            /* Auto: try every truth layer, keep the best. */
            var best = null, bestV = -1, second = -1;
            for (var n = 0; n < masks.length; n++) {
              var v = iou(mine, masks[n].mask);
              if (v > bestV) { second = bestV; bestV = v; best = masks[n].path; }
              else if (v > second) { second = v; }
            }
            rows.push({
              name: file.name,
              truth: best || '-',
              v: bestV < 0 ? NaN : bestV,
              margin: second >= 0 ? bestV - second : null
            });
          })
          .catch(function () {
            rows.push({ name: file.name, truth: named || chosen, v: NaN });
          }));
      })(fileList[i]);
    }

    Promise.all(jobs).then(function () {
      rows.sort(function (a, b) { return a.v - b.v; });
      var sum = 0, n = 0;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var tr = document.createElement('tr');
        var c1 = document.createElement('td');
        c1.textContent = r.name;
        var c2 = document.createElement('td');
        /* The margin over the runner-up says whether the match is decided or
         * a coin toss. A part that scores 0.71 against two different truth
         * layers has not really been identified. */
        c2.textContent = r.truth.replace(/^layers\//, '') +
          (r.margin != null && r.margin < 0.15 ? '  (+' + r.margin.toFixed(2) + ' unsicher)' : '');
        c2.style.color = '#98a1ad';
        var c3 = document.createElement('td');
        if (isNaN(r.v)) {
          c3.textContent = 'failed';
          c3.className = 'bad';
        } else {
          c3.textContent = r.v.toFixed(3);
          c3.className = r.v >= 0.85 ? 'good' : (r.v >= 0.7 ? 'warn' : 'bad');
          sum += r.v; n++;
        }
        tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3);
        table.appendChild(tr);
      }
      if (n) {
        var trm = document.createElement('tr');
        var m1 = document.createElement('td');
        m1.textContent = 'mean of ' + n;
        m1.style.fontWeight = '600';
        var m2 = document.createElement('td');
        var m3 = document.createElement('td');
        var mean = sum / n;
        m3.textContent = mean.toFixed(3);
        m3.className = mean >= 0.85 ? 'good' : (mean >= 0.7 ? 'warn' : 'bad');
        trm.appendChild(m1); trm.appendChild(m2); trm.appendChild(m3);
        table.appendChild(trm);
      }
    });
  }

  /* ================================================================== *
   * Wiring
   * ================================================================== */

  function boot() {
    bindPivotDrag();

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

    $('loopWindow').addEventListener('change', function () {
      if (state.fig) state.fig.loop = this.checked ? state.window : 0;
    });

    $('showBg').addEventListener('change', function () {
      var bg = document.querySelector('.idle-bg');
      if (bg) bg.style.display = this.checked ? '' : 'none';
    });

    $('figureSel').addEventListener('change', function () {
      loadFigure(this.value);
    });

    $('sheetBtn').addEventListener('click', buildSheet);

    $('eventsBtn').addEventListener('click', renderEvents);

    $('sheetSave').addEventListener('click', function () {
      var c = $('sheet');
      if (!c.width) buildSheet();
      c.toBlob(function (b) {
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
