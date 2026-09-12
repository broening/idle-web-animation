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
 *  4. Several of Disney's twelve principles are built into the blocks rather
 *     than left to whoever writes the JSON. docs/principles.md says which
 *     ones are genuinely enforced, which are partial, and which are not.
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

  /* For anything that ends up in a divisor. A period of 0 turns every sine
   * into NaN and a whole figure into matrix(NaN,...); an interval of 0 made
   * the blink loop run forever, because Math.floor(t/0) is Infinity and
   * Infinity + 1 is still Infinity. Both are reachable from hand-written
   * JSON, which is what the schema doc invites. */
  function pos(v, d) {
    return (typeof v === 'number' && isFinite(v) && v > 1e-6) ? v : d;
  }

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
   * irrational, so a single block never visibly repeats.
   *
   * This is NOT how the loading screen this project came from does it: that
   * one runs breathe at 4.2 s, handsway at 4.2 s and windsway at 3.4 s, and
   * phase-locks two of them on purpose. Checked, after an earlier version of
   * this comment claimed the opposite. */
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

  /* See the note in render(). Below 1/255 of a channel, so it cannot show. */
  var ALPHA_FLOOR = 0.0008;

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
      var p = pos(cfg.period, 4.0);
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
      var p = pos(cfg.period, 7.5);
      var a = organic(t, p, num(cfg.phase, 0));
      out.rot += a * num(cfg.degrees, 2.2) * s;
      /* A trace of drift along the swing keeps a wide cloak from looking
       * hinged to a nail. */
      out.tx += a * 0.0015 * s * env.width;
    },

    /* Blinking. Deterministic schedule, occasional double blink, and a hint
     * of widening just before the lid drops - principle 2, anticipation. */
    blink: function (t, cfg, layer, env, out) {
      var iv = pos(cfg.interval, 4.2);
      var dur = pos(cfg.duration, 0.13);
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
      var drift = organic(t, pos(cfg.period, 11.3), 0.31) * 0.35;
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
      var fps = pos(cfg.fps, 12);
      if (cfg.mode === 'burst') {
        var jitter = num(cfg.jitter, 0.45);
        var span = n / fps;
        /* A burst that runs longer than the gap between bursts is a
         * contradiction: the next one starts before this one ends. Rather
         * than pick a winner among overlapping copies - which returns one
         * frozen frame - widen the gap so it degrades into a plain cycle. */
        var every = Math.max(pos(cfg.every, 6.5), span);
        /* Look back far enough that a burst outlasting its own slot is still
         * found. Checking only the current slot silently truncated it: with
         * 4 frames at 1 fps every 0.5 s, frame 0 was the only one that ever
         * appeared and frames 1 to 3 were unreachable. */
        var back = Math.ceil(span / every) + 1;
        var i = Math.floor(t / every);
        out.frame = -1;
        /* Oldest still-running burst wins. Taking the newest instead means
         * the answer is always frame 0, because the newest slot has by
         * definition only just started - which is how the truncation looked
         * after the first attempt at this fix. */
        for (var b = back; b >= 0; b--) {
          var slot = i - b;
          var start = slot * every + hash01(slot + 7) * every * jitter;
          var dt = t - start;
          if (dt >= 0 && dt < span) { out.frame = Math.floor(dt * fps); break; }
        }
      } else {
        out.frame = Math.floor(((t * fps) % n + n) % n);
      }
    },

    /* A slow charge that fires in stages, each stronger than the last.
     *
     * One cycle is divided into `stages` equal slots. In each slot the effect
     * ramps up, holds, and ramps down again; slot n reaches n/stages of full
     * strength, so the build-up is visible rather than a single flash. A
     * layer only takes part from `showFrom` upwards, which is how three
     * separate bolt images become three steps of one discharge.
     *
     * The shape is taken from the loading screen this project came from,
     * which drove the same effect by hand with handBlitzStufen. */
    charge: function (t, cfg, layer, env, out) {
      var stages = Math.max(1, Math.round(num(cfg.stages, 3)));
      var cycle = pos(cfg.cycle, 24);
      var hold = pos(cfg.hold, 1.0);
      var ramp = pos(cfg.ramp, 0.35);
      var showFrom = Math.max(1, Math.round(num(cfg.showFrom, 1)));

      var slot = cycle / stages;
      var tt = t - Math.floor(t / cycle) * cycle;
      var idx = Math.floor(tt / slot);                 /* 0-based slot */
      var stage = idx + 1;                             /* 1..stages */
      /* The flash sits at the end of its slot, so the quiet build-up is what
       * fills most of the time. */
      var start = (idx + 1) * slot - hold - ramp * 2;
      var dt = tt - start;
      var span = hold + ramp * 2;

      var level = 0;
      if (dt >= 0 && dt < span && stage >= showFrom) {
        if (dt < ramp) level = dt / ramp;
        else if (dt < ramp + hold) level = 1;
        else level = 1 - (dt - ramp - hold) / ramp;
        level *= stage / stages;                       /* the gradation */
      }

      out.charge = Math.max(out.charge, level);
      if (level <= 0) {
        out.frame = -1;                                /* nothing to show */
      } else {
        out.opacity *= level;
        out.brightness += level * num(cfg.brightness, 0.6);
        /* A trace of scale so a bolt does not look pasted on. */
        out.sx += level * num(cfg.grow, 0.02);
        out.sy += level * num(cfg.grow, 0.02);
      }
    },

    /* Particles: a layer that rises once, fades, and comes back later.
     *
     * Every other block here oscillates around zero, which is right for a
     * body and wrong for anything that leaves. drift carries a layer along a
     * vector once per cycle and fades it at both ends. Between rises it is
     * not drawn at all. One copy on its own reads as a sliding block, which
     * is why this is meant to be used several times over: split the motes
     * into groups, give each group its own `phase`, and they leave the hand a
     * few at a time instead of all together.
     *
     * Same slot arithmetic as flipbook's burst mode, and for the same reason:
     * a rise that outlives its own slot has to stay findable, or it is
     * silently cut off at the slot boundary. */
    drift: function (t, cfg, layer, env, out) {
      var life = pos(cfg.life, 3.0);
      /* A rise longer than the gap would overlap its own next copy, and one
       * layer cannot be in two places. Widen the gap rather than pick. */
      var every = Math.max(pos(cfg.every, 4.0), life);
      /* Jitter may only spend the part of the slot the rise does not already
       * use. Past that, a late rise still runs when the next one is due, the
       * loop below has to choose one of them, and the layer jumps from the
       * old opacity straight to the new one in a single frame. Measured on
       * grim before this line: every 5.17, life 3.6, jitter 0.6 - the free
       * share was 0.30, and the spray flickered. */
      var jit = clamp(num(cfg.jitter, 0.5), 0, 1);
      var free = 1 - life / every;
      if (jit > free) jit = free;
      var ph = num(cfg.phase, 0);
      var tt = t - ph;
      var i = Math.floor(tt / every);
      var dt = -1;
      for (var b = Math.ceil(life / every) + 1; b >= 0; b--) {
        var slot = i - b;
        var d = tt - (slot * every + hash01(slot + 31) * every * jit);
        if (d >= 0 && d < life) { dt = d; break; }
      }
      if (dt < 0) { out.opacity = 0; return; }     /* between two rises */

      var u = dt / life;
      /* Eased out: a mote leaves fast and slows as it cools. Principle 6. */
      var e = 1 - (1 - u) * (1 - u);
      out.tx += e * num(cfg.dx, 0) + organic(t, 2.7, ph) * num(cfg.wander, 6);
      out.ty += e * num(cfg.dy, -120);
      /* In over the first eighth, out over the last half. Both ends matter: a
       * mote that appears at full strength reads as a sprite being switched
       * on, which is the thing this is trying not to look like.
       *
       * The two ends are deliberately lopsided. A group is drawn where it was
       * painted, so while it is still fading in it is also still sitting on
       * the source it came from - and a long fade-in leaves that source bare,
       * because every group has already climbed away from it before any of
       * them is visible. A fifth left a hole at the hand; an eighth does not. */
      out.opacity *= clamp(Math.min(u / 0.125, (1 - u) / 0.5, 1), 0, 1);
    },

    /* Light that lives: a lantern, a rune, an eye. Brightness and opacity
     * breathe on a period of their own, so it never locks to the chest. */
    glow: function (t, cfg, layer, env, out) {
      var s = num(cfg.strength, 1);
      var a = (organic(t, pos(cfg.period, 5.3), num(cfg.phase, 0)) + 1) * 0.5;
      /* Clamped, because strength is a slider that goes to 3. Unclamped, a
       * strength of 2 with the default min of 0.55 drives opacity negative
       * at the bottom of the cycle, and a negative opacity is not a dimmer
       * light - it is an invalid style the browser throws away. */
      out.opacity *= clamp(1 - (1 - num(cfg.min, 0.55)) * (1 - a) * s, 0, 1);
      out.brightness += a * num(cfg.brightness, 0.22) * s;
    }
  };

  /* ------------------------------------------------------------------ *
   * Solve: figure plus time gives plain state for every layer. No DOM.
   * ------------------------------------------------------------------ */

  /* Which image of a layer is on screen right now, or -1 for none.
   *
   * Both renderers call this, and that is the point. They used to decide
   * separately and disagreed: a layer with a ONE-entry `frames` array plus a
   * burst flipbook stayed visible forever in the DOM (which only switched
   * frames when there was more than one image) while the canvas hid it
   * between bursts. The contact sheet is supposed to be proof of what ships,
   * so a second opinion in the renderer is not a style question. */
  function frameOf(layer, st) {
    var n = (layer.frames && layer.frames.length) || 0;
    if (!n) return 0;                    /* plain single-image layer */
    if (st.frame === -1) return -1;      /* flipbook says: not now */
    if (st.frame < 0) return 0;          /* frames but no flipbook motion */
    return st.frame % n;
  }

  /* CSS mix-blend-mode and canvas globalCompositeOperation share most names
   * but not all. Translating here keeps the two renderers identical instead
   * of letting canvas silently fall back to whatever was set last. */
  var CANVAS_BLEND = {
    normal: 'source-over',
    'plus-lighter': 'lighter',
    'plus-darker': 'source-over'   /* no canvas equivalent; documented */
  };

  function canvasBlend(blend) {
    if (!blend) return 'source-over';
    if (CANVAS_BLEND[blend]) return CANVAS_BLEND[blend];
    return blend;
  }

  function chainDepth(byId, layer) {
    var d = 0, cur = layer, n = 0;
    /* Only a parent that actually resolves costs a follow-through step.
     * Counting a dangling "parent": "ghost" shifted the layer back in time
     * for a relationship that composes nothing. */
    while (cur && cur.parent && n++ < 32) {
      var next = byId[cur.parent];
      if (!next) break;
      cur = next;
      d++;
    }
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
    /* Bare objects, so a layer called "constructor" or "toString" cannot
     * return something from Object.prototype where a matrix is expected -
     * that crashed the whole figure, not just the one layer. */
    var byId = Object.create(null);
    var i, j, L;
    /* First wins, so a duplicate id cannot silently steal the parent of an
     * earlier layer. Keys below are the array index, not the id, so both
     * copies still get their own transform in both renderers. */
    for (i = 0; i < layers.length; i++) {
      if (byId[layers[i].id] === undefined) byId[layers[i].id] = layers[i];
    }
    var idIndex = Object.create(null);
    for (i = 0; i < layers.length; i++) {
      if (idIndex[layers[i].id] === undefined) idIndex[layers[i].id] = i;
    }

    var local = [];
    var state = [];

    for (i = 0; i < layers.length; i++) {
      L = layers[i];

      /* Principle 5, follow through and overlapping action: the deeper a
       * layer sits in the chain, the further back in time it reads. The hem
       * of a cloak therefore lags the shoulder that drags it, for free. */
      var lt = t - chainDepth(byId, L) * followLag - num(L.lag, 0);

      var out = {
        tx: 0, ty: 0, rot: 0, sx: 1, sy: 1,
        opacity: num(L.opacity, 1), brightness: 0, blink: 0, charge: 0, frame: -2
      };

      var ms = L.motions || [];
      for (j = 0; j < ms.length; j++) {
        var fn = MOTIONS[ms[j].type];
        if (fn) fn(lt, ms[j], L, env, out);
      }

      /* pivot was the one numeric field never passed through num(), so a
       * "pivot": [0.5] or a {x, y} object produced NaN in the translation
       * and the two renderers then disagreed completely: CSS threw the
       * declaration away, canvas ignored setTransform and kept the previous
       * matrix. */
      var pv = L.pivot;
      var px = (pv && num(pv[0], 0.5)) || 0.5;
      var py = (pv && num(pv[1], 0.5)) || 0.5;

      /* A standing correction in canvas pixels, on top of whatever the
       * motions do. Parts come out of one flat image, so most of them already
       * sit where they belong, but a few land two or three pixels off and no
       * motion setting can put them back - a seam is not movement.
       *
       * Children inherit it, because it rides in the local matrix: nudging a
       * head has to take the eyes painted on it along. The pivot deliberately
       * stays where it was. The pivot is the joint, chosen on the stage; this
       * is a correction to the pixels, and moving both would undo the nudge
       * for every layer that rotates. */
      var of = L.offset;
      var ox = of ? num(of[0], 0) : 0;
      var oy = of ? num(of[1], 0) : 0;

      local[i] = matTRS(out.tx + ox, out.ty + oy, out.rot, out.sx, out.sy,
                        px * width, py * height);

      /* Principle 11, solid drawing: layers displace by their own depth when
       * the pointer moves, so a flat stack of images reads as a space.
       *
       * Deliberately NOT part of the local matrix. Parallax is a property of
       * the camera, not of the joint, so a child must not inherit its
       * parent's shift and then add its own on top. It used to: the eyes,
       * riding the head, ended up 4.60 px off the face they are painted on at
       * full pointer deflection - a mask sliding around. Now it is applied
       * once, after the chain is composed. */
      state.push({
        id: L.id,
        index: i,
        parallaxX: parallax ? env.pointerX * parallax * num(L.depth, 0) * 26 : 0,
        parallaxY: parallax ? env.pointerY * parallax * num(L.depth, 0) * 14 : 0,
        parentIndex: (L.parent != null && idIndex[L.parent] !== undefined)
          ? idIndex[L.parent] : -1,
        /* Clamped here, not at the renderers. An opacity of -1 made the DOM
         * layer invisible (CSS clamps to 0) and the canvas layer fully
         * opaque (globalAlpha ignores an out-of-range value). */
        opacity: clamp(num(out.opacity, 1), 0, 1),
        brightness: out.brightness,
        blink: out.blink,
        charge: out.charge,
        frame: out.frame,
        role: L.role
      });
    }

    /* Compose each layer with its parent chain. Flat DOM, correct hierarchy.
     * Keyed by array index, so duplicate ids keep separate transforms. */
    var world = [];
    function worldOf(idx, guard) {
      if (world[idx]) return world[idx];
      var own = local[idx] || matIdentity();
      var pIdx = state[idx] ? state[idx].parentIndex : -1;
      var m = (pIdx >= 0 && pIdx !== idx && guard < 32)
        ? matMul(worldOf(pIdx, guard + 1), own) : own;
      /* Do not memoise a result that hit the depth guard: a shallower caller
       * would reuse a truncated chain and get a different answer purely from
       * where it happened to start. */
      if (guard < 31) world[idx] = m;
      return m;
    }

    /* A blink hides the layer that carries role "eyesOpen". The blink motion
     * may sit on that layer or on an ancestor - the schema reads as though
     * either works, and before this it silently only worked on the layer
     * itself. */
    function blinkAt(idx, guard) {
      var st = state[idx];
      if (!st) return 0;
      if (st.blink > 0) return st.blink;
      return (st.parentIndex >= 0 && st.parentIndex !== idx && guard < 32)
        ? blinkAt(st.parentIndex, guard + 1) : 0;
    }

    for (i = 0; i < state.length; i++) {
      var m = worldOf(i, 0);
      /* Last line of defence. If anything upstream still produced a
       * non-finite number, fall back to identity so at least both renderers
       * draw the same wrong thing instead of two different wrong things. */
      for (j = 0; j < 6; j++) {
        if (!isFinite(m[j])) { m = matIdentity(); break; }
      }
      m = [m[0], m[1], m[2], m[3],
           m[4] + state[i].parallaxX, m[5] + state[i].parallaxY];
      state[i].matrix = m;
      state[i].css = matToCss(m);
      var bl = blinkAt(i, 0);
      /* eyesOpen disappears while the lid is down; eyesClosed appears only
       * then. Hiding the open eyes without showing closed ones leaves a hole
       * where an eye should be, which is not a blink. */
      state[i].hidden = (state[i].role === 'eyesOpen' && bl > 0.5) ||
                        (state[i].role === 'eyesClosed' && bl <= 0.5);
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
    this._bound = [];
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
      bg.src = resolveSrc(f, this.base, f.background);
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

      /* A layer gets a `filter` only if one of its own motions can write
       * brightness - glow and charge are the two that do. Everything else is
       * left without one, so it never needs a render surface. See the note in
       * idle.css for what happened when they all had one. */
      var lit = false;
      var ms = L.motions || [];
      for (var mi = 0; mi < ms.length; mi++) {
        if (ms[mi] && (ms[mi].type === 'glow' || ms[mi].type === 'charge')) lit = true;
      }
      if (lit) box.style.willChange = 'transform, opacity, filter';

      var imgs = [];
      var hasFrames = !!(L.frames && L.frames.length);
      var srcs = hasFrames ? L.frames : [L.src];
      for (var k = 0; k < srcs.length; k++) {
        var img = document.createElement('img');
        img.src = resolveSrc(f, this.base, srcs[k]);
        img.alt = L.alt || '';
        img.draggable = false;
        /* Any frames array starts hidden, even a one-entry one: a burst
         * flipbook must be able to switch it off between bursts. */
        if (hasFrames) img.style.visibility = 'hidden';
        box.appendChild(img);
        imgs.push(img);
      }
      stage.appendChild(box);
      this._nodes[L.id] = {
        box: box, imgs: imgs, frames: hasFrames, shown: -2, layer: L,
        css: '', op: -1, fil: '', lit: lit
      };
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
      /* Every property below is written only when its value actually changed.
       * A style write on an unchanged value still marks the layer dirty. */
      if (s.css !== n.css) { n.box.style.transform = s.css; n.css = s.css; }

      /* Never written as a hard 0. A drift group is off for over a second
       * between two rises, and a browser is free to stop painting a fully
       * transparent layer and throw its decoded image away. Coming back then
       * costs a re-decode of a full-canvas WebP, which does not fit in a
       * frame, so the group appears one frame late and out of step with the
       * other nine.
       *
       * ALPHA_FLOOR * 255 is 0.2, so every channel still rounds to the same
       * byte it would have at zero. The layer stays painted, stays decoded,
       * and stays invisible. The canvas renderer keeps the true 0: it repaints
       * every frame from scratch and has nothing to lose.
       *
       * This costs no extra surface - a plain opacity does not promote. */
      var op = s.hidden ? 0 : s.opacity;
      if (op < ALPHA_FLOOR) op = ALPHA_FLOOR;
      if (op !== n.op) { n.box.style.opacity = op; n.op = op; }

      /* A layer can be off in two different ways, and the filter below has to
       * respect both: opacity at the floor, or a flipbook with no frame to
       * show. charge uses the second one - between flashes it sets frame -1
       * and leaves opacity alone - so an opacity test on its own reported all
       * eight of the priest's bolts as visible around the clock. */
      var f = n.frames ? frameOf(n.layer, s) : 0;
      var off = (op <= ALPHA_FLOOR) || (f === -1);

      /* A lit layer holds a constant brightness(1) while it is on screen,
       * rather than dropping to none whenever brightness happens to be zero:
       * a filter list that empties out tears the layer's render surface down
       * and rebuilds it on the next lit frame, one unpainted frame per switch.
       * While it is off it gives the filter up entirely, so a bolt that fires
       * for two seconds in twenty does not hold a surface for the other
       * eighteen - and the rebuild then lands on a frame with nothing to show
       * anyway. An unlit layer never gets a filter at all.
       *
       * This is the difference that matters on Edge. Grim's 22 layers each
       * carrying one was 22 render passes a frame, and Edge answered by
       * leaving whole layers unpainted. Now grim holds two and the priest,
       * mid-charge, four. */
      if (n.lit) {
        var fil = off
          ? '' : 'brightness(' + (1 + s.brightness).toFixed(3) + ')';
        if (fil !== n.fil) { n.box.style.filter = fil; n.fil = fil; }
      }

      if (n.frames) {
        if (f !== n.shown) {
          /* visibility, not display: a display:none image can be dropped from
           * the compositor and has to be decoded again when it comes back,
           * which is the same one-frame hole in a different place. */
          for (var k = 0; k < n.imgs.length; k++) {
            n.imgs[k].style.visibility = (k === f) ? 'visible' : 'hidden';
          }
          n.shown = f;
        }
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
      /* A throw inside the frame used to leave playing = true with no loop
       * queued, so play() early-returned forever and the figure sat frozen
       * while the button still read Pause. Stop cleanly instead. */
      try {
        self.render(t);
      } catch (err) {
        self.pause();
        self.lastError = err;
        if (global.console && console.error) console.error('idle.js render failed', err);
        return;
      }
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

  /* Stop the clock, drop the listeners, empty the host. Without this the only
   * way to replace a figure was to build a second one over the same element,
   * which left the first still running and still writing into orphaned
   * boxes - two rAF loops on one host. */
  IdleFigure.prototype.destroy = function () {
    this.pause();
    for (var i = 0; i < this._bound.length; i++) {
      var b = this._bound[i];
      b.el.removeEventListener(b.type, b.fn);
    }
    this._bound = [];
    if (this.host) this.host.innerHTML = '';
    this._nodes = {};
  };

  /* Pointer input in -1..1, for gaze and parallax. */
  IdleFigure.prototype.trackPointer = function (el) {
    var self = this;
    el = el || this.host;
    function move(e) {
      var r = el.getBoundingClientRect();
      self.pointerX = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      self.pointerY = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
    }
    function leave() { self.pointerX = 0; self.pointerY = 0; }
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', leave);
    /* Remembered so destroy() can actually take them off again. Anonymous
     * closures could never be removed, so repeated calls piled up. */
    this._bound.push({ el: el, type: 'mousemove', fn: move });
    this._bound.push({ el: el, type: 'mouseleave', fn: leave });
  };

  /* ------------------------------------------------------------------ *
   * Canvas rendering.
   *
   * The same solve() output, drawn with drawImage instead of CSS. This is
   * what makes the contact sheet exact and the size export possible without
   * a screenshot tool, a headless browser or a single npm package.
   * ------------------------------------------------------------------ */

  /* A layer's `src` is a path, always - that is what gets written into the
   * exported folder. A figure started from a dropped file has no path on any
   * server yet, so `figure.sources` maps the path to a blob URL for display
   * only. Both renderers go through here, and export drops the map. */
  function resolveSrc(figure, base, src) {
    if (figure && figure.sources && figure.sources[src]) return figure.sources[src];
    return base + src;
  }

  function loadImages(figure, base) {
    base = base ? base.replace(/\/+$/, '') + '/' : '';
    var jobs = [];
    var out = { _bg: null };

    function one(src) {
      return new Promise(function (res, rej) {
        var im = new Image();
        im.onload = function () { res(im); };
        im.onerror = function () { rej(new Error('cannot load ' + src)); };
        im.src = resolveSrc(figure, base, src);
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
      if (!s2 || s2.hidden) continue;
      var fi = frameOf(L, s2);
      if (fi < 0) continue;
      var bank = images[L.id];
      if (!bank) continue;
      var img = bank[fi];
      if (!img) continue;

      var m = s2.matrix;
      g.save();
      g.globalAlpha = s2.opacity;
      /* Canvas uses the same names as mix-blend-mode, so the contact sheet
       * shows what the page shows. */
      g.globalCompositeOperation = canvasBlend(L.blend);
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
    frameOf: frameOf,
    resolveSrc: resolveSrc,
    canvasBlend: canvasBlend,
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
