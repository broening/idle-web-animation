/*!
 * idle.js - layered idle animation player.
 *
 * Design rules, all of them load-bearing:
 *
 *  1. Everything is a pure function of time. solve(figure, t, ctx) returns the
 *     same state for the same t, always. That is what makes the timeline
 *     scrubbable and the contact sheet exact.
 *  2. No dependencies, no build step. Plain script tag, works from a folder.
 *  3. Chromium 103 is the floor (RedM / FiveM NUI). No syntax newer than that.
 *  4. Nine of Disney's twelve principles are enforced here, in the engine,
 *     not left to whoever writes the JSON. See docs/principles.md.
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;
  var DEG = 180 / Math.PI;

  /* ------------------------------------------------------------------ *
   * Math. Deterministic, allocation-light, no Math.random anywhere.
   * ------------------------------------------------------------------ */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  /* Deterministic pseudo-random in 0..1 from an integer. Same n, same value,
   * forever. Used for blink jitter, so scrubbing back shows the same blinks. */
  function hash01(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return x - Math.floor(x);
  }

  /* Principle 6, slow in and slow out: a sine is already eased at both ends,
   * so plain harmonic motion never starts or stops abruptly. */
  function wave(t, period, phase) {
    return Math.sin(((t / period) + (phase || 0)) * TAU);
  }

  /* Two sines whose periods sit at the golden ratio. Their combined period is
   * irrational, so the motion never visibly repeats - the same trick the
   * loading screen already uses by running breath at 4 s and wind at 7.5 s. */
  function organic(t, period, phase) {
    var a = Math.sin(((t / period) + (phase || 0)) * TAU);
    var b = Math.sin(((t / (period * 1.6180339887)) + (phase || 0) * 0.37) * TAU);
    return a * 0.78 + b * 0.22;
  }

  /* A single up-and-down pulse over dur seconds, eased at both ends. */
  function pulse(dt, dur) {
    if (dt < 0 || dt > dur) return 0;
    return Math.sin((dt / dur) * Math.PI);
  }

  /* ------------------------------------------------------------------ *
   * 2D matrices, as CSS matrix(a, b, c, d, e, f).
   * Parent transforms compose by multiplication, which keeps the DOM flat
   * and leaves draw order entirely to the layer list.
   * ------------------------------------------------------------------ */

  function matIdentity() { return [1, 0, 0, 1, 0, 0]; }

  function matMul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }

  /* Translate, rotate and scale about a pivot given in pixels. */
  function matTRS(tx, ty, rotDeg, sx, sy, px, py) {
    var r = rotDeg / DEG;
    var c = Math.cos(r), s = Math.sin(r);
    var a = c * sx, b = s * sx, cc = -s * sy, d = c * sy;
    return [
      a, b, cc, d,
      px + tx - (a * px + cc * py),
      py + ty - (b * px + d * py)
    ];
  }

  function matToCss(m) {
    return 'matrix(' + m[0].toFixed(6) + ',' + m[1].toFixed(6) + ',' +
           m[2].toFixed(6) + ',' + m[3].toFixed(6) + ',' +
           m[4].toFixed(3) + ',' + m[5].toFixed(3) + ')';
  }

  /* ------------------------------------------------------------------ *
   * The six building blocks.
   *
   * Each one reads (t, cfg, layer, env, out) and adds to an accumulator.
   * None of them touches the DOM, so all of this runs in Node for the
   * determinism test as happily as it runs in a browser.
   * ------------------------------------------------------------------ */

  var MOTIONS = {

    /* Breathing. Principle 1, squash and stretch: the chest gets taller and
     * narrower in the same instant, so the figure keeps its volume instead of
     * inflating like a balloon. */
    breathe: function (t, cfg, layer, env, out) {
      var s = num(cfg.strength, 1);
      var p = num(cfg.period, 4.0);
      var a = organic(t, p, num(cfg.phase, 0));
      out.sy += a * 0.012 * s;
      out.sx -= a * 0.0066 * s;
      out.ty -= a * 0.0045 * s * env.height;
    },

    /* Cloth, hair, a cloak in the wind. Rotation about the pivot, which is
     * principle 7, arcs: the hem travels along a curve, never in a straight
     * sideways slide. */
    sway: function (t, cfg, layer, env, out) {
      var s = num(cfg.strength, 1);
      var p = num(cfg.period, 7.5);
      var a = organic(t, p, num(cfg.phase, 0));
      out.rot += a * num(cfg.degrees, 2.2) * s;
      /* A trace of drift along the swing keeps a wide cloak from looking
       * hinged to a nail. */
      out.tx += a * 0.0015 * s * env.width;
    },

    /* Blinking. Deterministic schedule, occasional double blink, and a hint
     * of widening just before the lid drops - principle 2, anticipation. */
    blink: function (t, cfg, layer, env, out) {
      var iv = num(cfg.interval, 4.2);
      var dur = num(cfg.duration, 0.13);
      var i = Math.floor(t / iv);
      var amt = 0, pre = 0;
      for (var k = i - 1; k <= i + 1; k++) {
        var start = k * iv + hash01(k) * iv * 0.75;
        amt = Math.max(amt, pulse(t - start, dur));
        pre = Math.max(pre, pulse(t - start + 0.14, 0.14));
        if (hash01(k + 1000) < 0.18) {
          amt = Math.max(amt, pulse(t - start - dur * 2.1, dur));
        }
      }
      out.blink = Math.max(out.blink, amt);
      out.sy += pre * 0.010;
    },

    /* Looking around, and looking at the pointer. The vertical term is
     * quadratic in the horizontal one, so the eyeline follows a shallow arc
     * instead of a ruler-straight sweep. Principle 7 again. */
    gaze: function (t, cfg, layer, env, out) {
      var s = num(cfg.strength, 1);
      var reach = num(cfg.pixels, 9) * s;
      var drift = organic(t, num(cfg.period, 11.3), 0.31) * 0.35;
      var gx = clamp(env.pointerX * num(cfg.follow, 1) + drift, -1, 1);
      var gy = clamp(env.pointerY * num(cfg.follow, 1) * 0.6, -1, 1);
      out.tx += gx * reach;
      out.ty += gy * reach * 0.55 - gx * gx * reach * 0.18;
      out.rot += gx * num(cfg.degrees, 1.4) * s;
    },

    /* Flip-book effects: lightning, fire, smoke. Frames are separate images,
     * exactly as the loading screen already does it with hand-blitz-1..4.
     * mode "loop" runs forever, mode "burst" fires every few seconds. */
    flipbook: function (t, cfg, layer, env, out) {
      var n = (layer.frames && layer.frames.length) || 0;
      if (!n) { out.frame = -1; return; }
      var fps = num(cfg.fps, 12);
      if (cfg.mode === 'burst') {
        var every = num(cfg.every, 6.5);
        var jitter = num(cfg.jitter, 0.45);
        var i = Math.floor(t / every);
        var start = i * every + hash01(i + 7) * every * jitter;
        var dt = t - start;
        var span = n / fps;
        out.frame = (dt >= 0 && dt < span) ? Math.floor(dt * fps) : -1;
      } else {
        out.frame = Math.floor(((t * fps) % n + n) % n);
      }
    },

    /* Light that lives: a lantern, a rune, an eye. Brightness and opacity
     * breathe on a period of their own, so it never locks to the chest. */
    glow: function (t, cfg, layer, env, out) {
      var s = num(cfg.strength, 1);
      var a = (organic(t, num(cfg.period, 5.3), num(cfg.phase, 0)) + 1) * 0.5;
      out.opacity *= 1 - (1 - num(cfg.min, 0.55)) * (1 - a) * s;
      out.brightness += a * num(cfg.brightness, 0.22) * s;
    }
  };

  /* ------------------------------------------------------------------ *
   * Solve: figure plus time gives plain state for every layer. No DOM.
   * ------------------------------------------------------------------ */

  function chainDepth(byId, layer) {
    var d = 0, cur = layer, n = 0;
    while (cur && cur.parent && n++ < 32) { cur = byId[cur.parent]; d++; }
    return d;
  }

  function solve(figure, t, ctx) {
    ctx = ctx || {};
    var width = (figure.size && figure.size.width) || 1000;
    var height = (figure.size && figure.size.height) || 1000;
    var mo = figure.motion || {};
    var followLag = num(mo.followSeconds, 0.085);
    var parallax = num(mo.parallax, 0.35);
    var env = {
      width: width,
      height: height,
      pointerX: num(ctx.pointerX, 0),
      pointerY: num(ctx.pointerY, 0)
    };

    var layers = figure.layers || [];
    var byId = {};
    var i, j, L;
    for (i = 0; i < layers.length; i++) byId[layers[i].id] = layers[i];

    var local = {};
    var state = [];

    for (i = 0; i < layers.length; i++) {
      L = layers[i];

      /* Principle 5, follow through and overlapping action: the deeper a
       * layer sits in the chain, the further back in time it reads. The hem
       * of a cloak therefore lags the shoulder that drags it, for free. */
      var lt = t - chainDepth(byId, L) * followLag - num(L.lag, 0);

      var out = {
        tx: 0, ty: 0, rot: 0, sx: 1, sy: 1,
        opacity: num(L.opacity, 1), brightness: 0, blink: 0, frame: -2
      };

      var ms = L.motions || [];
      for (j = 0; j < ms.length; j++) {
        var fn = MOTIONS[ms[j].type];
        if (fn) fn(lt, ms[j], L, env, out);
      }

      /* Principle 11, solid drawing: layers displace by their own depth when
       * the pointer moves, so a flat stack of images reads as a space. */
      if (parallax && L.depth != null) {
        out.tx += env.pointerX * parallax * num(L.depth, 0) * 26;
        out.ty += env.pointerY * parallax * num(L.depth, 0) * 14;
      }

      var pv = L.pivot || [0.5, 0.5];
      local[L.id] = matTRS(out.tx, out.ty, out.rot, out.sx, out.sy,
                           pv[0] * width, pv[1] * height);

      state.push({
        id: L.id,
        opacity: out.opacity,
        brightness: out.brightness,
        blink: out.blink,
        frame: out.frame,
        hidden: (L.role === 'eyesOpen' && out.blink > 0.5)
      });
    }

    /* Compose each layer with its parent chain. Flat DOM, correct hierarchy. */
    var world = {};
    function worldOf(id, guard) {
      if (world[id]) return world[id];
      var l = byId[id];
      if (!l) return matIdentity();
      var own = local[id] || matIdentity();
      var m = (l.parent && guard < 32) ? matMul(worldOf(l.parent, guard + 1), own) : own;
      world[id] = m;
      return m;
    }
    for (i = 0; i < state.length; i++) {
      state[i].matrix = worldOf(state[i].id, 0);
      state[i].css = matToCss(state[i].matrix);
    }

    return state;
  }

  /* ------------------------------------------------------------------ *
   * Mount: build the DOM once, then push solved state into it.
   * ------------------------------------------------------------------ */

  /* opts.background: false leaves the backdrop out. The studio uses this -
   * when you are judging how a figure moves, a painted graveyard behind it is
   * noise. The field stays in figure.json for the target that wants it. */
  function IdleFigure(host, figure, baseUrl, opts) {
    opts = opts || {};
    this.host = host;
    this.figure = figure;
    this.showBackground = opts.background !== false;
    this.base = baseUrl ? baseUrl.replace(/\/+$/, '') + '/' : '';
    this.pointerX = 0;
    this.pointerY = 0;
    this.time = 0;
    this.playing = false;
    this.loop = 0;        /* seconds; 0 means run on forever */
    this._raf = 0;
    this._gen = 0;
    this._nodes = {};
    this._build();
  }

  IdleFigure.prototype._build = function () {
    var f = this.figure;
    var w = (f.size && f.size.width) || 1000;
    var h = (f.size && f.size.height) || 1000;

    this.host.innerHTML = '';
    if (this.host.className.indexOf('idle-host') < 0) {
      this.host.className = (this.host.className + ' idle-host').trim();
    }

    /* The background fills the host, not the stage. A backdrop is almost
     * never the same shape as the character canvas - the priest's is
     * 2752x1536 behind a 1000x1000 figure - and on a loading screen it has to
     * cover the whole screen while the figure stands in front of it. */
    if (f.background && this.showBackground) {
      var bg = document.createElement('img');
      bg.className = 'idle-bg';
      bg.src = this.base + f.background;
      bg.alt = '';
      bg.draggable = false;
      if (f.backgroundZoom) bg.style.transform = 'scale(' + f.backgroundZoom + ')';
      this.host.appendChild(bg);
    }

    var stage = document.createElement('div');
    stage.className = 'idle-stage';
    stage.style.width = w + 'px';
    stage.style.height = h + 'px';
    this.stage = stage;

    var layers = f.layers || [];
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var box = document.createElement('div');
      box.className = 'idle-layer';
      box.setAttribute('data-id', L.id);

      /* Lightning, fire and smoke are cheapest to produce as a short video on
       * a black field, cut into frames. Black composites away under "screen",
       * so the effect needs no alpha channel and no background removal pass.
       * mix-blend-mode has been in Chrome since 41, well under our floor. */
      if (L.blend) box.style.mixBlendMode = L.blend;

      var imgs = [];
      var srcs = (L.frames && L.frames.length) ? L.frames : [L.src];
      for (var k = 0; k < srcs.length; k++) {
        var img = document.createElement('img');
        img.src = this.base + srcs[k];
        img.alt = L.alt || '';
        img.draggable = false;
        if (srcs.length > 1) img.style.display = 'none';
        box.appendChild(img);
        imgs.push(img);
      }
      stage.appendChild(box);
      this._nodes[L.id] = { box: box, imgs: imgs, shown: -2 };
    }

    this.host.appendChild(stage);
    this.fit();
  };

  /* Scale the fixed-size stage into whatever box it was given. */
  IdleFigure.prototype.fit = function () {
    var f = this.figure;
    var w = (f.size && f.size.width) || 1000;
    var h = (f.size && f.size.height) || 1000;
    var r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var k = Math.min(r.width / w, r.height / h);
    this.stage.style.transform = 'translate(-50%, -50%) scale(' + k + ')';
    this.scale = k;
  };

  IdleFigure.prototype.render = function (t) {
    this.time = t;
    var st = solve(this.figure, t, { pointerX: this.pointerX, pointerY: this.pointerY });
    for (var i = 0; i < st.length; i++) {
      var s = st[i];
      var n = this._nodes[s.id];
      if (!n) continue;
      n.box.style.transform = s.css;
      n.box.style.opacity = s.hidden ? 0 : s.opacity;
      n.box.style.filter = s.brightness > 0.001
        ? 'brightness(' + (1 + s.brightness).toFixed(3) + ')'
        : '';
      if (n.imgs.length > 1 && s.frame !== n.shown) {
        for (var k = 0; k < n.imgs.length; k++) {
          n.imgs[k].style.display = (k === s.frame) ? '' : 'none';
        }
        n.shown = s.frame;
      }
    }
    return st;
  };

  /* Every play() opens a new generation. A frame callback from an older
   * generation returns immediately instead of fighting the current one.
   *
   * Without this, a pause() followed by a play() in the same frame leaves two
   * loops alive with different start times: the clock jitters, _raf points at
   * only one of them, and the next pause() stops the wrong one. That is
   * exactly how the studio froze while its button still read "Pause". */
  IdleFigure.prototype.play = function () {
    if (this.playing) return;
    this.playing = true;
    var self = this;
    var gen = ++this._gen;
    var now0 = global.performance ? performance.now() : Date.now();
    var t0 = now0 - this.time * 1000;
    function step(now) {
      if (gen !== self._gen || !self.playing) return;
      var t = (now - t0) / 1000;
      /* Looping is a review aid, not part of the figure. The motions run on
       * deliberately non-matching periods, so the window seam is visible -
       * that is the point of looking at a fixed window. */
      if (self.loop > 0) t -= Math.floor(t / self.loop) * self.loop;
      self.render(t);
      self._raf = global.requestAnimationFrame(step);
    }
    this._raf = global.requestAnimationFrame(step);
  };

  IdleFigure.prototype.pause = function () {
    this.playing = false;
    this._gen++;
    if (this._raf) global.cancelAnimationFrame(this._raf);
    this._raf = 0;
  };

  IdleFigure.prototype.seek = function (t) { this.pause(); this.render(t); };

  /* Pointer input in -1..1, for gaze and parallax. */
  IdleFigure.prototype.trackPointer = function (el) {
    var self = this;
    el = el || this.host;
    el.addEventListener('mousemove', function (e) {
      var r = el.getBoundingClientRect();
      self.pointerX = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      self.pointerY = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
    });
    el.addEventListener('mouseleave', function () {
      self.pointerX = 0;
      self.pointerY = 0;
    });
  };

  /* ------------------------------------------------------------------ *
   * Canvas rendering.
   *
   * The same solve() output, drawn with drawImage instead of CSS. This is
   * what makes the contact sheet exact and the size export possible without
   * a screenshot tool, a headless browser or a single npm package.
   * ------------------------------------------------------------------ */

  function loadImages(figure, base) {
    base = base ? base.replace(/\/+$/, '') + '/' : '';
    var jobs = [];
    var out = { _bg: null };

    function one(src) {
      return new Promise(function (res, rej) {
        var im = new Image();
        im.onload = function () { res(im); };
        im.onerror = function () { rej(new Error('cannot load ' + src)); };
        im.src = base + src;
      });
    }

    if (figure.background) {
      jobs.push(one(figure.background).then(function (im) { out._bg = im; }));
    }
    var layers = figure.layers || [];
    for (var i = 0; i < layers.length; i++) {
      (function (L) {
        var srcs = (L.frames && L.frames.length) ? L.frames : [L.src];
        out[L.id] = new Array(srcs.length);
        for (var k = 0; k < srcs.length; k++) {
          (function (idx) {
            jobs.push(one(srcs[idx]).then(function (im) { out[L.id][idx] = im; }));
          })(k);
        }
      })(layers[i]);
    }
    return Promise.all(jobs).then(function () { return out; });
  }

  /* Draw one frame into a 2D context. The context is expected to be sized
   * dw x dh; everything is scaled from the figure's own canvas size. */
  function drawFrame(g, figure, images, t, opts) {
    opts = opts || {};
    var w = (figure.size && figure.size.width) || 1000;
    var h = (figure.size && figure.size.height) || 1000;
    var dw = num(opts.width, w);
    var dh = num(opts.height, h);
    var k = Math.min(dw / w, dh / h);
    var ox = (dw - w * k) / 2;
    var oy = (dh - h * k) / 2;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, dw, dh);

    if (opts.background !== false && images._bg) {
      var bg = images._bg;
      var z = num(figure.backgroundZoom, 1);
      var s = Math.max(dw / bg.width, dh / bg.height) * z;
      g.drawImage(bg, (dw - bg.width * s) / 2, (dh - bg.height * s) / 2,
                  bg.width * s, bg.height * s);
    }

    var st = solve(figure, t, opts.ctx);
    var byId = {};
    for (var i = 0; i < st.length; i++) byId[st[i].id] = st[i];

    var layers = figure.layers || [];
    for (i = 0; i < layers.length; i++) {
      var L = layers[i];
      var s2 = byId[L.id];
      if (!s2 || s2.hidden || s2.frame === -1) continue;
      var bank = images[L.id];
      if (!bank) continue;
      var img = bank[s2.frame >= 0 ? s2.frame : 0];
      if (!img) continue;

      var m = s2.matrix;
      g.save();
      g.globalAlpha = s2.opacity;
      /* Canvas uses the same names as mix-blend-mode, so the contact sheet
       * shows what the page shows. */
      g.globalCompositeOperation = L.blend || 'source-over';
      if (s2.brightness > 0.001 && 'filter' in g) {
        g.filter = 'brightness(' + (1 + s2.brightness).toFixed(3) + ')';
      }
      /* Fit transform: scale by k and offset, then the layer's own matrix. */
      g.setTransform(k * m[0], k * m[1], k * m[2], k * m[3],
                     k * m[4] + ox, k * m[5] + oy);
      g.drawImage(img, 0, 0, w, h);
      g.restore();
      if ('filter' in g) g.filter = 'none';
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    return st;
  }

  var api = {
    IdleFigure: IdleFigure,
    solve: solve,
    loadImages: loadImages,
    drawFrame: drawFrame,
    MOTIONS: MOTIONS,
    _math: {
      hash01: hash01, wave: wave, organic: organic, pulse: pulse,
      matMul: matMul, matTRS: matTRS, clamp: clamp
    }
  };

  global.IdleFigure = IdleFigure;
  global.Idle = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
