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
     * of widening just before the lid drops - principle 2, anticipation.
     *
     * env.blink is a live input - a camera watching the streamer's eyes -
     * and when it is there it IS the blink: the schedule is not consulted.
     * The widening goes too, not just the lid. Anticipation is the figure
     * guessing that a blink is coming; with a real eye on the other end
     * there is nothing to guess, and a widening driven by the schedule would
     * twitch the eye 140 ms before a blink the person never made. */
    blink: function (t, cfg, layer, env, out) {
      if (env.blink >= 0) {
        out.blink = Math.max(out.blink, env.blink);
        return;
      }
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
       * them is visible. A fifth left a hole at the hand; an eighth does not.
       *
       * `fadeOut: false` drops the second term: a drip that has to vanish at
       * a hard edge - the mouth it fell out of, the floor it hit - looks
       * wrong going soft first. It still fades in, so the spawn itself does
       * not pop, and it still stops being drawn the instant life ends
       * (the dt < 0 branch above), so the cut is clean rather than a hold. */
      var fadeOut = cfg.fadeOut !== false;
      out.opacity *= fadeOut
        ? clamp(Math.min(u / 0.125, (1 - u) / 0.5, 1), 0, 1)
        : clamp(u / 0.125, 0, 1);
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

  /* Where an image sits on the canvas, as [x, y, width, height] in canvas
   * pixels - or null for an image that ships as a full canvas.
   *
   * A full-canvas layer costs width * height * 4 bytes of decoded pixels no
   * matter how little of it is painted. Pedro is 1792x1000, so every one of
   * his sixty files is 7.2 MB decoded and the figure alone is 410 MB. Cut to
   * the painted rectangle they come to 14 MB. That is the difference between
   * a machine that holds the whole scene and one that keeps throwing images
   * out and decoding them again - which is what a decode burst mid-load
   * sounds like on the loading screen: the music stalls.
   *
   * The layer box stays the full canvas, so pivots, parents and every matrix
   * in solve() are untouched. Only the image inside it moves and shrinks.
   *
   * `crops` runs parallel to `frames` and wins whenever it is there, even for
   * an index it does not cover. `crop` is the one rectangle of a `src` layer.
   * The studio's export writes both; nobody should have to by hand.
   *
   * Anything that is not four finite numbers with a positive size counts as
   * no crop at all. Without that check the two renderers split again: the
   * DOM dropped a bad value like "undefinedpx" and showed the image full
   * size, while drawImage got NaN and drew nothing. */
  function cropOf(layer, index, single) {
    /* `single` is for a mood's override, which may carry one `crop` for its
     * own `src` and nothing else. A `crops` written into an override is a
     * fixed key the validator reports; honouring it here would let the
     * renderers show something checkStates() calls ignored. */
    var r = (layer.crops && !single)
      ? (Array.isArray(layer.crops) ? layer.crops[index] : null)
      : layer.crop;
    if (!Array.isArray(r) || r.length !== 4) return null;
    for (var i = 0; i < 4; i++) {
      if (typeof r[i] !== 'number' || !isFinite(r[i])) return null;
    }
    if (r[2] <= 0 || r[3] <= 0) return null;
    return r;
  }

  /* ------------------------------------------------------------------ *
   * Moods ("states").
   *
   * A mood is an input, like the pointer. It is not a pose on a timeline:
   * nothing here keyframes anything, and solve() stays a pure function of
   * its arguments - time plus ctx.pointerX, ctx.pointerY, ctx.state, and the
   * live face inputs ctx.blink and ctx.mouth.
   *
   * A mood lists only what differs from the layers as written ("neutral"),
   * and only from a short list of keys: the picture (`src`, `crop`), a
   * standing correction (`offset`, `tilt`), `hidden`, and the parameters of
   * motions the layer already has. Pivot, parent, depth, role and blend are
   * the rig, and every mood shares one rig. If a mood could move a pivot,
   * a blend between two moods would have to decide where a joint is halfway
   * between two anatomies, and the parent chain that carries follow-through
   * would no longer be one chain.
   * ------------------------------------------------------------------ */

  /* Lowercase only, so a stream overlay can match an OBS scene called
   * "Sad - Intro" to the mood "sad" without guessing at case. */
  var STATE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

  var STATE_SECONDS = 0.4;

  /* Keys the validator names as part of the rig, so its message can say
   * why rather than just "unknown". The engine ignores them either way. */
  var RIG_KEYS = {
    id: 1, pivot: 1, parent: 1, depth: 1, role: 1, blend: 1, lag: 1,
    frames: 1, crops: 1, motions: 1, opacity: 1, alt: 1
  };

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function isPlain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /* The overrides of one mood, or null for neutral.
   *
   * Own properties only, for the same reason byId in solve() is a bare
   * object: a mood called "constructor" must not resolve to
   * Object.prototype.constructor and be read as a table of layers. An
   * invalid name is treated like an unknown one, so the engine never shows a
   * mood that stateNames() does not list. */
  function stateTable(figure, name) {
    if (typeof name !== 'string' || name === 'neutral' || !STATE_NAME.test(name)) return null;
    var all = figure && figure.states;
    if (!isPlain(all) || !hasOwn(all, name)) return null;
    return isPlain(all[name]) ? all[name] : null;
  }

  function overrideOf(table, id) {
    if (!table || typeof id !== 'string' || !hasOwn(table, id)) return null;
    return isPlain(table[id]) ? table[id] : null;
  }

  /* `neutral` first, then every mood the engine would actually show, in the
   * order of the file. One caveat that belongs to JavaScript, not to us: an
   * all-digit name like "2" is listed before the others, because object keys
   * that look like array indices always enumerate first. */
  function stateNames(figure) {
    var names = ['neutral'];
    var all = figure && figure.states;
    if (!isPlain(all)) return names;
    for (var k in all) {
      if (hasOwn(all, k) && stateTable(figure, k)) names.push(k);
    }
    return names;
  }

  /* 0 is a hard cut. A negative or non-finite value is a typo, not a wish
   * for an instant switch, so it gets the default. The ceiling is there
   * because a 500 s blend is indistinguishable from a mood that never
   * arrives, and the page has no way to tell the author that is what they
   * wrote. */
  function stateSecondsOf(figure) {
    var v = num(figure && figure.motion && figure.motion.stateSeconds, STATE_SECONDS);
    if (v < 0) return STATE_SECONDS;
    return v > 5 ? 5 : v;
  }

  /* How far a blend that started at `since` has come by t, 0..1.
   *
   * A `since` that is not a finite number cannot be placed on the clock at
   * all; the blend is taken as finished, so the figure shows where it was
   * asked to go rather than freezing on where it came from. A `since` in the
   * future - after scrubbing back past the moment of the switch - gives 0,
   * which is honest: at that time the switch had not happened yet. */
  function stateWeight(figure, t, since) {
    if (typeof since !== 'number' || !isFinite(since)) return 1;
    var ss = stateSecondsOf(figure);
    var w = ss > 0 ? (t - since) / ss : (t >= since ? 1 : 0);
    if (w >= 0) return w > 1 ? 1 : w;
    return w < 0 ? 0 : 1;                 /* NaN from a NaN t: finished */
  }

  /* A layer's motion with a mood's parameters laid over it.
   *
   * A new object every time, never the layer's own: the studio edits
   * figure.states live, and a merge written back into the layer would leak
   * one mood into every other.
   *
   * A value only replaces one of the same kind. A number that is not
   * finite, or a string where the layer has a number, keeps the layer's
   * value instead of handing the motion something its num()/pos() would turn
   * into the motion's global default - `"period": "slow"` on a torso that
   * breathes at 5.5 should leave it at 5.5, not reset it to 4.0. A key the
   * layer never set is passed on as is; the motion validates it like any
   * other. `type` is the one key a mood cannot touch, because it would turn
   * one motion into another. */
  function mergeMotion(cfg, over) {
    var m = Object.create(null);
    var k;
    for (k in cfg) if (hasOwn(cfg, k)) m[k] = cfg[k];
    for (k in over) {
      if (!hasOwn(over, k) || k === 'type') continue;
      var v = over[k];
      var was = m[k];
      if (typeof v === 'number' && !isFinite(v)) continue;
      if (was !== undefined && typeof v !== typeof was) continue;
      m[k] = v;
    }
    return m;
  }

  /* Every image a layer can show, in a fixed order, each with the rectangle
   * it is pinned to. The DOM builds one <img> per entry and the canvas loads
   * one Image per entry, so both work from the same list.
   *
   * A frames layer lists its frames, one per index and never deduplicated,
   * because the index is what the flipbook picks. A single-image layer lists
   * its own src first and then every other picture a mood can swap in, each
   * path once. A mood cannot give a frames layer a src: the flipbook picks
   * among frames, and a second picture beside them would have no index.
   *
   * One file, one cut. When two moods show the same path, the first one's
   * crop is used for both, and the layer's own crop wins over any mood's -
   * which is what the studio's Export writes anyway, since it cuts per file. */
  function imagesOf(layer, figure) {
    var list = [];
    var k;
    if (layer.frames && layer.frames.length) {
      for (k = 0; k < layer.frames.length; k++) {
        list.push({ src: layer.frames[k], crop: cropOf(layer, k) });
      }
      return list;
    }
    list.push({ src: layer.src, crop: cropOf(layer, 0) });
    var names = stateNames(figure);
    for (var i = 1; i < names.length; i++) {
      var ov = overrideOf(stateTable(figure, names[i]), layer.id);
      if (!ov || typeof ov.src !== 'string' || !ov.src) continue;
      var seen = false;
      for (k = 0; k < list.length; k++) if (list[k].src === ov.src) seen = true;
      if (!seen) list.push({ src: ov.src, crop: cropOf(ov, 0, true) });
    }
    return list;
  }

  /* Which picture of a layer is on screen for one solved state, and where it
   * sits: { index, src, crop }.
   *
   * This is frameOf and cropOf grown up, and it exists for the same reason
   * they do: both renderers ask it, so they cannot disagree about which
   * picture a mood shows. `index` is the slot in the layer's own images - the
   * frame for a frames layer, -1 when the flipbook shows nothing, and 0 for a
   * single-image layer whether or not a mood swapped the picture. Slot 0 is
   * the fallback a renderer draws when it has no image loaded for `src`.
   *
   * `src` comes from solve(), which has already applied the mood and made the
   * hard switch at the middle of a blend. A state object without `src`, from
   * a caller that built one by hand, shows the layer's own picture. */
  function imageOf(layer, st, figure) {
    var n = (layer.frames && layer.frames.length) || 0;
    if (n) {
      var fi = frameOf(layer, st);
      return fi < 0 ? { index: -1, src: null, crop: null }
                    : { index: fi, src: layer.frames[fi], crop: cropOf(layer, fi) };
    }
    var src = (st && typeof st.src === 'string') ? st.src : layer.src;
    if (src === layer.src) return { index: 0, src: src, crop: cropOf(layer, 0) };
    var pics = imagesOf(layer, figure);
    for (var k = 1; k < pics.length; k++) {
      if (pics[k].src === src) return { index: 0, src: src, crop: pics[k].crop };
    }
    return { index: 0, src: src, crop: null };
  }

  /* Human-readable problems with figure.states, [] when there are none.
   *
   * The engine never throws over a bad mood; it ignores what it cannot use.
   * That keeps a figure on screen, and it also means a typo is silent. This
   * is where it stops being silent. Pure: no file access, so it runs the
   * same in the studio, in Node and in a test. */
  function checkStates(figure) {
    var out = [];
    if (!figure || figure.states === undefined) return out;
    var all = figure.states;
    if (!isPlain(all)) {
      out.push('states has to be an object of moods, like { "sad": { "kopf": { "tilt": -2 } } }');
      return out;
    }
    var mo = figure.motion;
    var ss = mo && mo.stateSeconds;
    if (ss !== undefined && !(typeof ss === 'number' && isFinite(ss) && ss >= 0 && ss <= 5)) {
      out.push('motion.stateSeconds ' + JSON.stringify(ss) + ' is not a number from 0 to 5; ' +
               stateSecondsOf(figure) + ' is used');
    }
    var layers = figure.layers || [];
    var byId = Object.create(null);
    var i;
    for (i = 0; i < layers.length; i++) {
      if (layers[i] && byId[layers[i].id] === undefined) byId[layers[i].id] = layers[i];
    }
    function finite(v) { return typeof v === 'number' && isFinite(v); }

    for (var name in all) {
      if (!hasOwn(all, name)) continue;
      if (name === 'neutral') {
        out.push('states.neutral is ignored: neutral is the layers as written, so change those instead');
        continue;
      }
      if (!STATE_NAME.test(name)) {
        out.push('states.' + name + ' is ignored: a mood name is lowercase letters, digits, - and _, ' +
                 'starts with a letter or digit, and is at most 32 characters');
        continue;
      }
      var tab = all[name];
      if (!isPlain(tab)) {
        out.push('states.' + name + ' has to be an object of layer ids');
        continue;
      }
      for (var id in tab) {
        if (!hasOwn(tab, id)) continue;
        var at = 'states.' + name + '.' + id;
        var L = byId[id];
        if (!L) { out.push(at + ': there is no layer "' + id + '"'); continue; }
        var ov = tab[id];
        if (!isPlain(ov)) { out.push(at + ' has to be an object'); continue; }
        var frames = !!(L.frames && L.frames.length);
        for (var k in ov) {
          if (!hasOwn(ov, k)) continue;
          var v = ov[k];
          if (k === 'src') {
            if (frames) out.push(at + '.src is ignored: the layer has frames, and the flipbook picks among those');
            else if (typeof v !== 'string' || !v) out.push(at + '.src has to be the path of an image');
          } else if (k === 'crop') {
            if (frames || typeof ov.src !== 'string' || !ov.src) {
              /* '.' + k rather than the word spelled out: test-agreement reads
               * this file and refuses any `.crop` outside cropOf. */
              out.push(at + '.' + k + ' is ignored: it belongs to a src of the mood\'s own');
            } else if (!cropOf(ov, 0, true)) {
              out.push(at + '.' + k + ' has to be [x, y, width, height], four numbers with a positive size');
            }
          } else if (k === 'offset') {
            if (!Array.isArray(v) || v.length !== 2 || !finite(v[0]) || !finite(v[1])) {
              out.push(at + '.offset has to be [x, y], two numbers in canvas pixels');
            }
          } else if (k === 'tilt') {
            if (!finite(v)) out.push(at + '.tilt has to be a number of degrees');
          } else if (k === 'hidden') {
            if (typeof v !== 'boolean') out.push(at + '.hidden has to be true or false');
          } else if (hasOwn(MOTIONS, k)) {
            var has = false;
            var ms = L.motions || [];
            for (i = 0; i < ms.length; i++) if (ms[i] && ms[i].type === k) has = true;
            if (!has) {
              out.push(at + '.' + k + ' is ignored: the layer has no ' + k +
                       ' motion, and a mood changes motions, it does not add them');
            } else if (!isPlain(v)) {
              out.push(at + '.' + k + ' has to be an object of parameters');
            } else {
              for (var p in v) {
                if (!hasOwn(v, p)) continue;
                var pv = v[p];
                if (p === 'type') {
                  out.push(at + '.' + k + '.type is ignored: a mood cannot turn one motion into another');
                } else if (p === 'mode') {
                  if (pv !== 'loop' && pv !== 'burst') out.push(at + '.' + k + '.mode has to be "loop" or "burst"');
                } else if (p === 'fadeOut') {
                  if (typeof pv !== 'boolean') out.push(at + '.' + k + '.fadeOut has to be true or false');
                } else if (!finite(pv)) {
                  out.push(at + '.' + k + '.' + p + ' has to be a number');
                }
              }
            }
          } else if (hasOwn(RIG_KEYS, k)) {
            out.push(at + '.' + k + ' is ignored: ' + k + ' is part of the rig, and every mood shares one rig');
          } else {
            out.push(at + '.' + k + ' is ignored: a mood can change src, crop, offset, tilt, hidden ' +
                     'and the parameters of the layer\'s motions, nothing else');
          }
        }
      }
    }
    return out;
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

  /* ctx.state is one of three things:
   *
   *   absent, "neutral", or a name the figure does not have  -> neutral
   *   "sad"                                                  -> that mood
   *   { from: "neutral", to: "sad", since: 12.3 }            -> a blend
   *
   * `since` is on the same clock as t. The blend is a function of t like
   * everything else, so the same (t, ctx) gives the same frame and a scrubbed
   * timeline shows exactly what playback showed.
   *
   * The layers are solved once per mood, so each side is its own continuous
   * function of time, and only the mix between them moves. That is what keeps
   * a torso breathing at 4.0 s from jumping when it is asked to breathe at
   * 5.5 s: nothing re-times the sine mid-stride, the old one fades out while
   * the new one fades in. Both passes happen only while a blend is actually
   * running; before and after it this is one pass, and a figure without moods
   * takes exactly the path it took before moods existed. */
  function solve(figure, t, ctx) {
    ctx = ctx || {};
    var input = ctx.state;
    if (input && typeof input === 'object') {
      var from = stateTable(figure, input.from);
      var to = stateTable(figure, input.to);
      var w = stateWeight(figure, t, input.since);
      if (from === to || w >= 1) return solveLayers(figure, t, ctx, to);
      if (w <= 0) return solveLayers(figure, t, ctx, from);
      return mixStates(solveLayers(figure, t, ctx, from), solveLayers(figure, t, ctx, to), w);
    }
    return solveLayers(figure, t, ctx, stateTable(figure, input));
  }

  /* Two solved layer sets, mixed w of the way from a to b.
   *
   * The matrices are mixed number by number. That is not a proper
   * interpolation of a rotation - halfway between two angles the scale dips by
   * cos(half the difference) - but moods differ by a few pixels and a few
   * degrees: 5 degrees apart, the dip at the midpoint is 0.1 %, well under a
   * pixel on a 1000 px canvas, and it is gone again 0.2 s later. Decomposing
   * and recomposing every matrix every frame would cost more than it shows.
   *
   * What cannot be mixed switches at the middle: whether a layer is hidden,
   * which frame or picture shows, the blink and charge levels the roles read.
   * Half a picture is not a thing a layer can show. Position and motion carry
   * the change smoothly, so the swap lands inside a movement already under
   * way, which is where a cut hides best.
   *
   * ctx.blink and ctx.mouth need nothing here. Both sides were solved with
   * the same ctx, so a live blink or mouth is the same number on each, and
   * the roles they drive only differ where a mood's own `hidden` does. */
  function mixStates(a, b, w) {
    var out = [];
    var late = w >= 0.5;
    for (var i = 0; i < a.length; i++) {
      var p = a[i], q = b[i], d = late ? q : p;
      var m = [];
      for (var j = 0; j < 6; j++) m[j] = p.matrix[j] + (q.matrix[j] - p.matrix[j]) * w;
      /* Same keys in the same order as solveLayers() writes them, so a blend
       * and a plain frame serialise alike. */
      out.push({
        id: p.id,
        index: p.index,
        parallaxX: p.parallaxX,
        parallaxY: p.parallaxY,
        parentIndex: p.parentIndex,
        opacity: p.opacity + (q.opacity - p.opacity) * w,
        brightness: p.brightness + (q.brightness - p.brightness) * w,
        blink: d.blink,
        charge: d.charge,
        frame: d.frame,
        role: p.role,
        src: d.src,
        matrix: m,
        css: matToCss(m),
        hidden: d.hidden
      });
    }
    return out;
  }

  /* The layers for one mood. `table` is that mood's overrides, or null for
   * neutral - and with null every line below does what solve() did before
   * moods existed, to the bit. */
  function solveLayers(figure, t, ctx, table) {
    var width = (figure.size && figure.size.width) || 1000;
    var height = (figure.size && figure.size.height) || 1000;
    var mo = figure.motion || {};
    var followLag = num(mo.followSeconds, 0.085);
    var parallax = num(mo.parallax, 0.35);
    var env = {
      width: width,
      height: height,
      pointerX: num(ctx.pointerX, 0),
      pointerY: num(ctx.pointerY, 0),
      /* Live face input, see IdleFigure#blink. -1 means "not given", which
       * the blink motion reads as "run your own schedule": a figure nobody
       * feeds a camera to takes exactly the path it always took. A string,
       * NaN or Infinity counts as not given, the same way num() treats a bad
       * pointer - a tracker that loses the face and reports NaN must fall
       * back to the schedule, not freeze the lids at whatever NaN compares as. */
      blink: (typeof ctx.blink === 'number' && isFinite(ctx.blink)) ? clamp(ctx.blink, 0, 1) : -1,
      /* The mouth has no schedule to fall back to, so "not given" is simply
       * closed. */
      mouth: clamp(num(ctx.mouth, 0), 0, 1)
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
    var hides = [];

    for (i = 0; i < layers.length; i++) {
      L = layers[i];
      /* Read inline, every frame, rather than merged into a derived figure
       * once. The studio edits figure.states while the figure plays, and the
       * next frame has to show the edit without anyone rebuilding anything.
       * A duplicate id gets the override on every copy, since the mood names
       * the id. */
      var ov = table ? overrideOf(table, L.id) : null;
      var hasFrames = !!(L.frames && L.frames.length);

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
        if (!fn) continue;
        var cfg = ms[j];
        /* A mood changes the numbers of a motion the layer has. It does not
         * add one: a motion type the layer lacks is simply never looked up,
         * because this loop only visits the layer's own. */
        if (ov && typeof cfg.type === 'string' && hasOwn(ov, cfg.type) && isPlain(ov[cfg.type])) {
          cfg = mergeMotion(cfg, ov[cfg.type]);
        }
        fn(lt, cfg, L, env, out);
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

      /* tilt is the rotating sibling of offset: a standing angle about the
       * pivot, in the local matrix, so a tilted head takes its eyes along.
       * It exists for moods more than for rigs - a head a few pixels lower and
       * two degrees forward reads as sad before any picture changes - but it
       * is a plain layer field, so neutral can carry one too. */
      var tilt = num(L.tilt, 0);
      var hide = L.hidden === true;
      var src = hasFrames ? null : (typeof L.src === 'string' ? L.src : null);

      /* A mood's value replaces the layer's, it does not add to it: the file
       * says what the head looks like when sad, not how far it moved to get
       * there. So a layer with a cutting correction in `offset` needs that
       * correction in the mood's offset too. A malformed value keeps the
       * layer's own rather than zeroing it. */
      if (ov) {
        tilt = num(ov.tilt, tilt);
        if (Array.isArray(ov.offset)) {
          ox = num(ov.offset[0], ox);
          oy = num(ov.offset[1], oy);
        }
        if (typeof ov.hidden === 'boolean') hide = ov.hidden;
        if (!hasFrames && typeof ov.src === 'string' && ov.src) src = ov.src;
      }
      hides[i] = hide;

      local[i] = matTRS(out.tx + ox, out.ty + oy, tilt ? out.rot + tilt : out.rot,
                        out.sx, out.sy, px * width, py * height);

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
        role: L.role,
        /* The picture a single-image layer shows under this mood, null for a
         * frames layer. Which rectangle it sits in is imageOf()'s call, not
         * this one's - both renderers ask there. */
        src: src
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
      /* `hidden: true` wins over both roles. A mood that takes the lids away
       * altogether - a face with its eyes squeezed shut behind a hand - must
       * not have them flash back in on every blink. */
      /* The mouth works the same way, on ctx.mouth instead of a motion: the
       * open mouth shows only above half, the closed one at half and below,
       * so exactly one of a pair is on screen at any value. One threshold and
       * no memory of the last frame. A camera's mouth value hovering around
       * 0.5 would flap the picture every frame; holding it steady needs two
       * thresholds and the previous answer, and the previous answer is state
       * solve() does not keep. The page that reads the camera keeps it. */
      state[i].hidden = hides[i] ||
                        (state[i].role === 'eyesOpen' && bl > 0.5) ||
                        (state[i].role === 'eyesClosed' && bl <= 0.5) ||
                        (state[i].role === 'mouthOpen' && env.mouth <= 0.5) ||
                        (state[i].role === 'mouthClosed' && env.mouth > 0.5);
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
    /* The mood asked for last. Read it, do not write it - setState() keeps it
     * in step with _stateMix, which is what actually goes into ctx.state: a
     * name, or a running blend. */
    this.state = 'neutral';
    this._stateMix = 'neutral';
    /* Live face input, 0..1, for a page that reads a camera: `blink` is how
     * far the lids are down, `mouth` how far the mouth is open. Both go into
     * ctx on the next render(), like the pointer.
     *
     * Leave `blink` undefined and the figure keeps blinking on its own
     * schedule; set it and the schedule stops, so a streamer who holds their
     * eyes open is not overruled by a blink the figure invented. Set it back
     * to undefined when the tracker loses the face. `mouth` undefined is a
     * closed mouth. Smoothing and hysteresis are the page's job: solve() is a
     * pure function and remembers nothing from the frame before. A paused
     * figure does not redraw by itself when these change; call render(). */
    this.blink = undefined;
    this.mouth = undefined;
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
      var srcs = [];
      var hasFrames = !!(L.frames && L.frames.length);
      /* One <img> per picture the layer can show, moods included, all of
       * them loading now. A mood switch then only flips visibility; building
       * the <img> at the switch would show the empty box for however long the
       * file takes to arrive and decode, which on a stream is a head that
       * vanishes for a frame or three every time the scene changes. */
      var pics = imagesOf(L, f);
      for (var k = 0; k < pics.length; k++) {
        var img = document.createElement('img');
        img.src = resolveSrc(f, this.base, pics[k].src);
        srcs.push(pics[k].src);
        img.alt = L.alt || '';
        img.draggable = false;
        /* Decode off the main thread. Sixty layers decoding in one go on the
         * main thread is a visible hitch at load. */
        img.decoding = 'async';
        /* A cropped file is smaller than the canvas, so idle.css's blanket
         * 100%/100% would stretch it. Pin it back to the rectangle it was
         * cut from. Layers without a crop keep the full-canvas behaviour. */
        var cr = pics[k].crop;
        if (cr) {
          img.style.left = cr[0] + 'px';
          img.style.top = cr[1] + 'px';
          img.style.width = cr[2] + 'px';
          img.style.height = cr[3] + 'px';
        }
        /* Any frames array starts hidden, even a one-entry one: a burst
         * flipbook must be able to switch it off between bursts. */
        if (hasFrames) img.style.visibility = 'hidden';
        /* A mood's picture waits hidden behind the layer's own. A layer with
         * no mood pictures never gets a visibility write at all, as before. */
        else if (k > 0) img.style.visibility = 'hidden';
        box.appendChild(img);
        imgs.push(img);
      }
      stage.appendChild(box);
      this._nodes[L.id] = {
        box: box, imgs: imgs, srcs: srcs, frames: hasFrames,
        shown: hasFrames ? -2 : 0, layer: L,
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
    /* A blend under the window loop is only ever right by accident: the
     * clock jumps back to 0 at the seam, which puts every `since` either in
     * the future (the old mood again) or long past. setState() does not start
     * one while the loop is on, and a blend that was running when the loop
     * was switched on shows its target instead. */
    var mix = this._stateMix;
    if (mix && typeof mix === 'object' && this.loop > 0) mix = mix.to;
    var st = solve(this.figure, t, {
      pointerX: this.pointerX, pointerY: this.pointerY, state: mix,
      blink: this.blink, mouth: this.mouth
    });
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
      var pic = imageOf(n.layer, s, this.figure);
      var f = pic.index;
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
      } else if (n.imgs.length > 1) {
        /* A picture this node was not built with - a mood src added in the
         * studio after the figure was mounted - falls back to the layer's own
         * picture, which is also what drawFrame() draws while it has no image
         * loaded for that path. Remounting picks the new picture up. */
        var want = 0;
        for (var q = 1; q < n.srcs.length; q++) {
          if (n.srcs[q] === pic.src) { want = q; break; }
        }
        if (want !== n.shown) {
          for (var kk = 0; kk < n.imgs.length; kk++) {
            n.imgs[kk].style.visibility = (kk === want) ? 'visible' : 'hidden';
          }
          n.shown = want;
        }
      }
    }
    return st;
  };

  /* Ask for a mood by name. Returns false for a name the figure does not
   * have, and changes nothing then.
   *
   * The blend starts from whatever currently shows more. Switching from sad
   * to happy while a blend from neutral to sad is only a quarter done starts
   * from neutral, not from a sad the viewer has barely seen; three quarters
   * done, it starts from sad. The picture swap sits at the middle of a blend,
   * so this is also the side whose pictures are on screen - the new blend
   * never has to swap a picture back before it swaps forward.
   *
   * `since` is this.time, the player's own clock, the same one render() hands
   * to solve(). Three cases switch hard instead of blending:
   *  - the window loop is on: its clock jumps back at the seam, see render();
   *  - stateSeconds is 0: that is what 0 means;
   *  - the figure is paused: its clock does not move, so a blend starting now
   *    would sit at 0 forever and a paused figure would never show the mood
   *    it was just asked for. */
  IdleFigure.prototype.setState = function (name) {
    var f = this.figure;
    if (name !== 'neutral' && !stateTable(f, name)) return false;
    if (name === this.state) return true;

    var from = this.state;
    var mix = this._stateMix;
    if (mix && typeof mix === 'object' && stateWeight(f, this.time, mix.since) < 0.5) {
      from = mix.from;
    }
    /* The mood it came from may have been deleted in the studio since. */
    if (from !== 'neutral' && !stateTable(f, from)) from = 'neutral';

    this.state = name;
    if (from === name || this.loop > 0 || !this.playing || stateSecondsOf(f) === 0) {
      this._stateMix = name;
    } else {
      this._stateMix = { from: from, to: name, since: this.time };
    }
    if (!this.playing) this.render(this.time);
    return true;
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
    /* Pointer events, not mouse events: a finger never sends a mousemove
     * while it drags, so touch got no gaze at all. A finger lifting fires
     * pointerleave, which recentres; pointercancel is the browser taking
     * the gesture over for a scroll. touch-action is left alone on purpose -
     * setting it would stop the page scrolling under the figure. */
    var types = { pointermove: move, pointerleave: leave, pointercancel: leave };
    for (var type in types) {
      el.addEventListener(type, types[type]);
      /* Remembered so destroy() can actually take them off again. Anonymous
       * closures could never be removed, so repeated calls piled up. */
      this._bound.push({ el: el, type: type, fn: types[type] });
    }
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
        /* The bank keeps its old shape - bank[k] is frame k, or the single
         * picture at 0 - because the studio's export walks it by index. Every
         * picture, the moods' included, is also filed under its path in
         * bank.bySrc, which is where drawFrame() looks first. By path and not
         * by position, because the studio edits figure.states live: an index
         * into a list of mood pictures points at a different file the moment
         * one is removed, a path does not. */
        var pics = imagesOf(L, figure);
        var own = (L.frames && L.frames.length) ? L.frames.length : 1;
        var bank = out[L.id] = new Array(own);
        bank.bySrc = Object.create(null);
        for (var k = 0; k < pics.length; k++) {
          (function (idx) {
            jobs.push(one(pics[idx].src).then(function (im) {
              if (idx < own) bank[idx] = im;
              bank.bySrc[pics[idx].src] = im;
            }));
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
      var pic = imageOf(L, s2, figure);
      if (pic.index < 0) continue;
      var bank = images[L.id];
      if (!bank) continue;
      /* By path first, which is how mood pictures are found. An images
       * object without that entry - built by hand, or loaded before a mood
       * picture was added - gets the bank slot and that slot's own rectangle,
       * exactly what this drew before moods existed, and exactly what the
       * page shows for a picture its nodes were not built with. */
      var img = (bank.bySrc && pic.src !== null) ? bank.bySrc[pic.src] : null;
      var cr = pic.crop;
      if (!img) {
        img = bank[pic.index];
        cr = cropOf(L, pic.index);
      }
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
      /* The same rectangle the DOM renderer pins the <img> to, so the
       * contact sheet keeps matching the page. */
      if (cr) g.drawImage(img, cr[0], cr[1], cr[2], cr[3]);
      else g.drawImage(img, 0, 0, w, h);
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
    cropOf: cropOf,
    imageOf: imageOf,
    imagesOf: imagesOf,
    stateNames: stateNames,
    stateSeconds: stateSecondsOf,
    checkStates: checkStates,
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
