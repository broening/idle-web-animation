/*!
 * package.js - build a shareable OBS package from a figure.
 *
 * The studio's "OBS package (zip)" button hands this file everything it has
 * already prepared (the sized and cut figure, the file contents of idle.js,
 * idle.css and scene.js, the logo settings) and gets back the text files that
 * go into the zip next to the pictures:
 *
 *   IdleObsPackage.build(opts)    -> [{ name, text }]   obs.html, ANLEITUNG.txt, LICENSE.txt?
 *   IdleObsPackage.validate(opts) -> [problem strings]  [] when build() will succeed
 *
 * The contract, field by field, is in gates/PLAN-obs-package.md.
 *
 * Why a separate, pure file and not code inside studio.js: a package is
 * handed to a person who has no repo, no Python and no server, and opens
 * obs.html from a folder in OBS. Everything that can go wrong in that page is
 * decided here, as strings, so tools/test-addons.mjs can prove it in Node:
 * no DOM, no fetch, no Date, no Math.random. The same opts give the same
 * bytes, which is also what lets two builds of one figure be compared.
 *
 * The part that breaks for real is escaping. The page carries the figure as
 * JSON and the player as inline script, and the HTML parser ends a <script>
 * at the first "</script" it meets, wherever that sits: inside a string, a
 * regex or a comment. A layer called "</script><script>alert(1)</script>"
 * would otherwise run as code in the streamer's OBS. So:
 *   - the figure JSON writes every "<" as <, which JSON.parse reads back
 *     as the same character;
 *   - inline JS is re-tokenised: comments are dropped, and "</" and "<!--"
 *     inside strings and regex literals are written as "<\/" and "<\x21--",
 *     which mean the same characters to JavaScript but not to the HTML parser;
 *   - inline CSS writes "</style" as "<\/style".
 * build() then checks its own output and throws rather than return a page
 * whose tags close early.
 *
 * Chromium 103 is the floor for this file and for everything it writes into
 * obs.html: OBS 28 to 30 embed Chromium 103. See tools/check-compat.py.
 */
(function (global) {
  'use strict';

  var LICENSES = { 'CC-BY-4.0': true };
  var LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';

  /* Same alphabet as STATE_NAME in player/idle.js. Kept as a copy on purpose:
   * the builder receives idle.js as a string for inlining and never runs it,
   * and tools/test-addons.mjs holds stateNamesOf() equal to Idle.stateNames. */
  var STATE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

  /* The logo file sits next to obs.html and is written into CSS as
   * url('<file>'). Plain ASCII without quotes, slashes or spaces keeps that
   * one string valid in CSS, in a zip on every OS and on every file system
   * (AGENTS.md: a Mac stores an umlaut in a different form). */
  var LOGO_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(webp|png|jpg|jpeg|gif|svg|avif)$/i;

  var DATE = /^\d{4}-\d{2}-\d{2}$/;

  /* The loading screen's wipe timings (GH_Loading_Screen, --wipe-delay and
   * --wipe-dur). The gleam starts two seconds after the wipe has finished. */
  var WIPE_DELAY = 0.5;
  var WIPE_DUR = 2.4;
  var GLEAM_EVERY = 9;
  var GLEAM_AFTER = 2;

  /* A breathe block without its own period runs at the engine's default,
   * pos(cfg.period, 4.0) in player/idle.js, so that is its period too. */
  var BREATHE_DEFAULT = 4.0;
  var GLOW_FALLBACK = 4.2;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isPlain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /* Canvas pixels with three decimals at most, and never "-0" or "1e-7":
   * the numbers land in JSON and in CSS, and have to read the same in both. */
  function fmt(v) {
    var r = Math.round(v * 1000) / 1000;
    return r === 0 ? 0 : r;
  }

  function figureSize(figure) {
    var s = (figure && figure.size) || {};
    return {
      width: (isNum(s.width) && s.width > 0) ? s.width : 1000,
      height: (isNum(s.height) && s.height > 0) ? s.height : 1000
    };
  }

  /* player/idle.js stateNames(), rule for rule: neutral first, then every
   * own key of figure.states with a valid name and a plain object as value. */
  function stateNamesOf(figure) {
    var names = ['neutral'];
    var all = figure && figure.states;
    if (!isPlain(all)) return names;
    for (var k in all) {
      if (hasOwn(all, k) && k !== 'neutral' && STATE_NAME.test(k) && isPlain(all[k])) {
        names.push(k);
      }
    }
    return names;
  }

  /* The glow breathes with the figure, as it does on the loading screen:
   * the first breathe block in layer order decides the period. */
  function glowPeriodOf(figure, logo) {
    if (logo && isNum(logo.period) && logo.period > 0) return logo.period;
    var layers = (figure && Array.isArray(figure.layers)) ? figure.layers : [];
    for (var i = 0; i < layers.length; i++) {
      var ms = (layers[i] && Array.isArray(layers[i].motions)) ? layers[i].motions : [];
      for (var j = 0; j < ms.length; j++) {
        if (ms[j] && ms[j].type === 'breathe') {
          return (isNum(ms[j].period) && ms[j].period > 0) ? ms[j].period : BREATHE_DEFAULT;
        }
      }
    }
    return GLOW_FALLBACK;
  }

  /* Centre x/y and width are fractions of the canvas; the box is in canvas
   * pixels because the element lives inside player.stage, which fit() scales
   * as a whole. Height follows the picture's own aspect, so it never
   * stretches. */
  function logoBox(figure, logo) {
    var size = figureSize(figure);
    var w = logo.width * size.width;
    var h = w / logo.aspect;
    return {
      left: fmt(logo.x * size.width - w / 2),
      top: fmt(logo.y * size.height - h / 2),
      width: fmt(w),
      height: fmt(h)
    };
  }

  function startStateOf(opts) {
    return (typeof opts.startState === 'string' && opts.startState) ? opts.startState : 'neutral';
  }

  function textOf(v) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim() : ''; }

  /* "pedro" reads as a name in a sentence as "Pedro". Only the first letter:
   * "mein-pedro" stays as it was typed otherwise. */
  function displayName(name) {
    var n = textOf(name);
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : n;
  }

  /* ------------------------------------------------------------------ *
   * validate()
   * ------------------------------------------------------------------ */

  function validate(opts) {
    var p = [];
    if (!isPlain(opts)) return ['opts is missing'];

    if (!textOf(opts.name)) p.push('name is empty');

    var figure = opts.figure;
    if (!isPlain(figure)) {
      p.push('figure is missing');
    } else {
      if (!Array.isArray(figure.layers) || !figure.layers.length) p.push('figure has no layers');
      if (figure.size !== undefined) {
        var s = figure.size;
        if (!isPlain(s) || !isNum(s.width) || s.width <= 0 || !isNum(s.height) || s.height <= 0) {
          p.push('figure.size needs a width and a height above 0');
        }
      }
    }

    var src = opts.sources;
    if (!isPlain(src)) {
      p.push('sources is missing');
    } else {
      if (typeof src.idleJs !== 'string' || !src.idleJs) p.push('sources.idleJs is empty');
      if (typeof src.idleCss !== 'string' || !src.idleCss) p.push('sources.idleCss is empty');
      if (typeof src.sceneJs !== 'string' || !src.sceneJs) p.push('sources.sceneJs is empty');
    }

    var logo = opts.logo;
    if (logo !== null && logo !== undefined) {
      if (!isPlain(logo)) {
        p.push('logo must be null or an object');
      } else {
        if (typeof logo.file !== 'string' || !LOGO_FILE.test(logo.file)) {
          p.push('logo.file must be a plain ASCII file name like logo.webp (letters, digits, . _ -, an image extension)');
        }
        if (!isNum(logo.aspect) || logo.aspect <= 0) p.push('logo.aspect must be a number above 0');
        if (!isNum(logo.x) || logo.x < 0 || logo.x > 1) p.push('logo.x must be between 0 and 1');
        if (!isNum(logo.y) || logo.y < 0 || logo.y > 1) p.push('logo.y must be between 0 and 1');
        if (!isNum(logo.width) || logo.width <= 0 || logo.width > 1) p.push('logo.width must be above 0 and at most 1');
        var flags = ['wipe', 'glow', 'gleam'];
        for (var i = 0; i < flags.length; i++) {
          var fv = logo[flags[i]];
          if (fv !== undefined && typeof fv !== 'boolean') p.push('logo.' + flags[i] + ' must be true or false');
        }
        if (logo.period !== undefined && logo.period !== null &&
            (!isNum(logo.period) || logo.period <= 0 || logo.period > 60)) {
          p.push('logo.period must be above 0 and at most 60 seconds');
        }
      }
    }

    if (opts.startState !== undefined && opts.startState !== '' && isPlain(figure)) {
      if (stateNamesOf(figure).indexOf(opts.startState) < 0) {
        p.push('startState "' + String(opts.startState) + '" is not a mood of this figure (' +
          stateNamesOf(figure).join(', ') + ')');
      }
    }

    if (opts.credit !== undefined && typeof opts.credit !== 'string') p.push('credit must be text');
    else if (textOf(opts.credit).length > 200) p.push('credit is longer than 200 characters');

    var lic = opts.license;
    if (lic !== undefined && lic !== '' && !(typeof lic === 'string' && hasOwn(LICENSES, lic))) {
      p.push('license "' + String(lic) + '" is not supported (only CC-BY-4.0 or none)');
    } else if (lic === 'CC-BY-4.0' && !textOf(opts.credit)) {
      /* CC BY is attribution and nothing else. A licence with nobody to
       * attribute to would hand the receiver a promise they cannot keep. */
      p.push('CC-BY-4.0 needs a credit: the licence is attribution to someone');
    }

    if (opts.date !== undefined && opts.date !== '' && !(typeof opts.date === 'string' && DATE.test(opts.date))) {
      p.push('date must look like 2026-09-13');
    }

    return p;
  }

  /* ------------------------------------------------------------------ *
   * Inlining: comment stripping and tag-safe escaping.
   * ------------------------------------------------------------------ */

  /* Inside string and regex literals these mean the same to JavaScript and
   * nothing to the HTML parser. \x21 is "!" and, unlike \!, is also valid in
   * a regex with the u flag. */
  function jsLiteralSafe(text) {
    return text.replace(/<\//g, '<\\/').replace(/<!--/g, '<\\x21--');
  }

  /* A kept comment is inert for JavaScript, but not for the HTML parser. */
  function commentSafe(text) {
    return text.replace(/<\//g, '<\\/').replace(/<!--/g, '<!- -');
  }

  function isWordChar(c) { return /[A-Za-z0-9_$]/.test(c); }

  /* Keywords after which a "/" starts a regex rather than a division. */
  var REGEX_AFTER_WORD = {
    'return': 1, 'typeof': 1, 'instanceof': 1, 'in': 1, 'of': 1, 'new': 1, 'delete': 1,
    'void': 1, 'throw': 1, 'case': 1, 'do': 1, 'else': 1, 'yield': 1, 'await': 1
  };

  function skipQuoted(src, i, q) {
    var n = src.length;
    var j = i + 1;
    while (j < n) {
      var c = src.charAt(j);
      if (c === '\\') { j += 2; continue; }
      j++;
      if (c === q) break;
      /* An unterminated '...' or "..." ends at the line; a template may span
       * lines. */
      if (c === '\n' && q !== '`') break;
    }
    return j;
  }

  /* Returns the index just past the closing "/" (flags are read as a word by
   * the caller). "/" inside [...] does not close the literal. */
  function skipRegex(src, i) {
    var n = src.length;
    var j = i + 1;
    var inClass = false;
    while (j < n) {
      var c = src.charAt(j);
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') return j;
      j++;
      if (inClass) { if (c === ']') inClass = false; }
      else if (c === '[') inClass = true;
      else if (c === '/') return j;
    }
    return j;
  }

  /* Drops comments from classic ES5 script, keeps "/*!" banners, collapses
   * blank lines, and makes every literal tag-safe. This is a tokenizer for
   * the sources this repo ships (no nested template expressions), not a
   * general JavaScript parser; tools/test-addons.mjs holds the stripped
   * idle.js to the same solve() output as the original.
   *
   * Why strip at all: the comments are most of idle.js, a package is a file
   * a streamer opens, and one comment in scene.js carries a URL that would
   * make the page look like it talks to the network. */
  function stripJs(src) {
    var out = [];
    var pending = '';
    var n = src.length;
    var i = 0;
    var lastSig = '';
    var lastWord = '';

    function flush() {
      if (!pending) return;
      var nl = pending.lastIndexOf('\n');
      if (nl >= 0) out.push(out.length ? '\n' + pending.slice(nl + 1).replace(/[^ \t]/g, '') : '');
      else out.push(pending);
      pending = '';
    }

    function emit(text) { flush(); out.push(text); }

    while (i < n) {
      var c = src.charAt(i);
      var d = src.charAt(i + 1);

      if (c === '/' && d === '/') {
        var e = src.indexOf('\n', i);
        i = e < 0 ? n : e;
        continue;
      }
      if (c === '/' && d === '*') {
        var close = src.indexOf('*/', i + 2);
        var end = close < 0 ? n : close + 2;
        var body = src.slice(i, end);
        if (src.charAt(i + 2) === '!') {
          /* Without \r: a Windows checkout and a Mac checkout of the same
           * idle.js must build the same bytes. */
          emit(commentSafe(body.replace(/\r/g, '')));
        } else {
          /* A block comment with a line break in it is a line terminator for
           * automatic semicolon insertion. Keep that meaning. */
          pending += body.indexOf('\n') >= 0 ? '\n' : ' ';
        }
        i = end;
        continue;
      }
      if (c === '\'' || c === '"' || c === '`') {
        var qe = skipQuoted(src, i, c);
        emit(jsLiteralSafe(src.slice(i, qe)));
        lastSig = 'a';
        lastWord = '';
        i = qe;
        continue;
      }
      if (c === '/' && (lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.indexOf(lastSig) >= 0 ||
          (lastSig === 'a' && hasOwn(REGEX_AFTER_WORD, lastWord)))) {
        var re = skipRegex(src, i);
        var lit = src.slice(i, re);
        var bodyEnd = lit.charAt(lit.length - 1) === '/' ? lit.length - 1 : lit.length;
        emit('/' + jsLiteralSafe(lit.slice(1, bodyEnd)) + lit.slice(bodyEnd));
        lastSig = 'a';
        lastWord = '';
        i = re;
        continue;
      }
      if (isWordChar(c)) {
        var w = i;
        while (w < n && isWordChar(src.charAt(w))) w++;
        var word = src.slice(i, w);
        emit(word);
        lastSig = 'a';
        lastWord = word;
        i = w;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        if (c !== '\r') pending += c;
        i++;
        continue;
      }
      emit(c);
      /* x++ / 2 is a division: a postfix ++ or -- ends an operand. */
      lastSig = ((c === '+' || c === '-') && src.charAt(i - 1) === c) ? 'a' : c;
      lastWord = '';
      i++;
    }
    if (pending.indexOf('\n') >= 0) out.push('\n');
    return out.join('');
  }

  /* CSS comments go the same way; strings are left alone. RAWTEXT <style>
   * only ends at "</style", so that is the one sequence to break. */
  function stripCss(src) {
    var out = '';
    var n = src.length;
    var i = 0;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '/' && src.charAt(i + 1) === '*') {
        var close = src.indexOf('*/', i + 2);
        i = close < 0 ? n : close + 2;
        out += ' ';
        continue;
      }
      if (c === '"' || c === '\'') {
        var j = skipQuoted(src, i, c);
        out += src.slice(i, j);
        i = j;
        continue;
      }
      if (c !== '\r') out += c;
      i++;
    }
    out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').replace(/^\s+/, '');
    return out.replace(/<\/style/gi, '<\\/style');
  }

  function jsonForScript(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
  }

  function htmlText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------------ *
   * The logo, ported from GH_Loading_Screen/index.html (logo block).
   *
   * Two elements, and that is load-bearing: .logo carries only the glow
   * (filter: drop-shadow). A mask on the same element would clip the glow at
   * the element's edge. .logo-inner carries the picture, the wipe mask and
   * the light band.
   *
   * Chromium 103 only knows the -webkit- mask properties (unprefixed arrived
   * in 120), so every mask property is written twice.
   * ------------------------------------------------------------------ */

  var SHADOW_REST = 'drop-shadow(0 2px 6px rgba(0,0,0,0.6)) drop-shadow(0 0 6px rgba(217,255,56,0.10)) saturate(1) brightness(1)';

  function logoCss(logo, period) {
    var url = "url('" + logo.file + "')";
    var ease = 'cubic-bezier(0.38, 0.02, 0.2, 1)';
    var css = [];

    /* The resting shadow stays when the glow is off: it is what keeps a light
     * logo readable over a light scene, not an effect. */
    css.push(
      '.logo {',
      '  position: absolute;',
      '  z-index: 1;',
      '  pointer-events: none;',
      '  filter: ' + SHADOW_REST + ';',
      logo.glow ? '  animation: logoAtem ' + fmt(period) + 's ease-in-out infinite;' : '',
      '}',
      '.logo-inner {',
      '  position: absolute;',
      '  top: 0; right: 0; bottom: 0; left: 0;',
      '  background-image: ' + url + ';',
      '  background-size: contain;',
      '  background-position: center;',
      '  background-repeat: no-repeat;'
    );
    if (logo.wipe) {
      /* The wipe mask is three logos wide: opaque on the left, soft edge,
       * transparent on the right. Sliding it from 100% to 0% reveals the logo
       * from left to right. Without the wipe there is no mask at all, so the
       * logo is there from the first frame. */
      css.push(
        '  -webkit-mask-image: linear-gradient(90deg, #000 0%, #000 40%, rgba(0,0,0,0) 47%, rgba(0,0,0,0) 100%);',
        '          mask-image: linear-gradient(90deg, #000 0%, #000 40%, rgba(0,0,0,0) 47%, rgba(0,0,0,0) 100%);',
        '  -webkit-mask-size: 300% 100%;',
        '          mask-size: 300% 100%;',
        '  -webkit-mask-repeat: no-repeat;',
        '          mask-repeat: no-repeat;',
        '  -webkit-mask-position: 100% 50%;',
        '          mask-position: 100% 50%;',
        '  animation: logoWipe ' + WIPE_DUR + 's ' + ease + ' ' + WIPE_DELAY + 's forwards;'
      );
    }
    css.push('}');

    if (logo.wipe) {
      css.push(
        '@keyframes logoWipe {',
        '  from { -webkit-mask-position: 100% 50%; mask-position: 100% 50%; }',
        '  to   { -webkit-mask-position: 0% 50%;   mask-position: 0% 50%; }',
        '}',
        /* The light band travels on the wipe edge. The logo itself is its
         * mask, so only the lettering lights up, never the empty box. */
        '.logo-inner::before {',
        "  content: '';",
        '  position: absolute;',
        '  top: 0; right: 0; bottom: 0; left: 0;',
        '  -webkit-mask-image: ' + url + ';',
        '          mask-image: ' + url + ';',
        '  -webkit-mask-size: contain;     mask-size: contain;',
        '  -webkit-mask-position: center;  mask-position: center;',
        '  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;',
        '  background-image: linear-gradient(90deg, rgba(217,255,56,0) 32%, rgba(236,255,160,0.22) 35%, rgba(255,255,236,0.55) 38%, rgba(236,255,160,0.20) 41%, rgba(217,255,56,0) 45%);',
        '  background-size: 300% 100%;',
        '  background-repeat: no-repeat;',
        '  background-position: 100% 50%;',
        '  mix-blend-mode: screen;',
        '  opacity: 0;',
        '  animation: logoSheen ' + WIPE_DUR + 's ' + ease + ' ' + WIPE_DELAY + 's forwards;',
        '}',
        '@keyframes logoSheen {',
        '  0%   { background-position: 100% 50%; opacity: 0; }',
        '  12%  { opacity: 1; }',
        '  86%  { opacity: 1; }',
        '  100% { background-position: 0% 50%; opacity: 0; }',
        '}'
      );
    }

    if (logo.glow) {
      /* Nothing moves, only the colour breathes: brightest at 50%, where the
       * figure has fully breathed in, then a magenta afterglow. Both tones
       * come from the Grim Hollow logo the effect was made for. */
      css.push(
        '@keyframes logoAtem {',
        '  0%, 100% { filter: ' + SHADOW_REST + '; }',
        '  50% { filter: drop-shadow(0 2px 6px rgba(0,0,0,0.6)) drop-shadow(0 0 18px rgba(217,255,56,0.40)) saturate(1.18) brightness(1.08); }',
        '  78% { filter: drop-shadow(0 2px 6px rgba(0,0,0,0.6)) drop-shadow(0 0 12px rgba(239,14,70,0.28)) saturate(1.08) brightness(1.02); }',
        '}'
      );
    }

    if (logo.gleam) {
      var gleamDelay = (logo.wipe ? WIPE_DELAY + WIPE_DUR : 0) + GLEAM_AFTER;
      css.push(
        '.logo-inner::after {',
        "  content: '';",
        '  position: absolute;',
        '  top: 0; right: 0; bottom: 0; left: 0;',
        '  -webkit-mask-image: ' + url + ';',
        '          mask-image: ' + url + ';',
        '  -webkit-mask-size: contain;     mask-size: contain;',
        '  -webkit-mask-position: center;  mask-position: center;',
        '  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;',
        '  background-image: linear-gradient(105deg, rgba(255,255,255,0) 40%, rgba(255,255,255,0.70) 46%, rgba(255,255,255,0) 54%);',
        '  background-size: 300% 100%;',
        '  background-repeat: no-repeat;',
        '  background-position: 100% 50%;',
        '  mix-blend-mode: screen;',
        '  animation: logoGleam ' + GLEAM_EVERY + 's ease-in-out ' + fmt(gleamDelay) + 's infinite;',
        '}',
        '@keyframes logoGleam {',
        '  0%, 55%   { background-position: 100% 50%; }',
        '  88%, 100% { background-position: 0% 50%; }',
        '}'
      );
    }

    /* "Reduce motion" in the system: the logo shows at once and holds still. */
    css.push(
      '@media (prefers-reduced-motion: reduce) {',
      '  .logo, .logo-inner, .logo-inner::before, .logo-inner::after { animation: none; }',
      '  .logo-inner { -webkit-mask-image: none; mask-image: none; }',
      '  .logo-inner::before { opacity: 0; }',
      '}'
    );

    var text = [];
    for (var i = 0; i < css.length; i++) if (css[i]) text.push(css[i]);
    return text.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * obs.html
   * ------------------------------------------------------------------ */

  /* The page's own script. Static except for the logo block, which is only
   * written when there is a logo, so a package without one carries no logo
   * code at all. */
  function pageScript(hasLogo) {
    var s = [
      '(function () {',
      "  'use strict';",
      '',
      '  function readJson(id) {',
      '    return JSON.parse(document.getElementById(id).textContent);',
      '  }',
      '',
      '  function report(what, e) {',
      "    if (window.console && console.error) console.error('OBS package: ' + what, e);",
      '  }',
      '',
      '  try {',
      "    var fig = readJson('idle-figure');",
      "    var cfg = readJson('idle-obs-config');",
      "    var host = document.getElementById('host');",
      '',
      '    /* The pictures sit next to this file, so the base is the page itself.',
      '     * background: false keeps the page transparent over the scene. */',
      "    var player = new IdleFigure(host, fig, '', { background: false });"
    ];
    if (hasLogo) {
      s.push(
        '',
        '    /* Inside the stage, after the layers: fit() scales it with the',
        '     * figure, and it sits above every layer. */',
        '    var box = cfg.logo;',
        "    var logo = document.createElement('div');",
        "    logo.className = 'logo';",
        "    logo.setAttribute('aria-hidden', 'true');",
        "    logo.style.left = box.left + 'px';",
        "    logo.style.top = box.top + 'px';",
        "    logo.style.width = box.width + 'px';",
        "    logo.style.height = box.height + 'px';",
        "    var inner = document.createElement('div');",
        "    inner.className = 'logo-inner';",
        '    logo.appendChild(inner);',
        '    player.stage.appendChild(logo);'
      );
    }
    s.push(
      '',
      '    /* No trackPointer(): no mouse ever moves over an OBS source, and the',
      '     * gaze runs its own drift without one. A source can be resized at any',
      '     * time, so the stage re-fits. */',
      "    window.addEventListener('resize', function () { player.fit(); });",
      '',
      '    var names = Idle.stateNames(fig);',
      '    var start = cfg.startState;',
      '    function apply(name) {',
      '      try { player.setState(name); } catch (e) { report(\'setState failed\', e); }',
      '    }',
      '',
      '    /* Before play(): a paused player switches hard, so the first frame',
      '     * already shows the start mood instead of blending into it. */',
      '    apply(start);',
      '    player.play();',
      '',
      '    /* A scene name with a mood word switches to it; one without falls',
      '     * back to the start mood. Outside OBS this does nothing. */',
      "    if (window.IdleObs && typeof IdleObs.watchScene === 'function') {",
      '      IdleObs.watchScene(function (sceneName) {',
      '        apply(IdleObs.matchState(sceneName, names, start));',
      '      });',
      '    }',
      '  } catch (e) {',
      '    /* Never text on the page: on a stream it would read as a graphic. */',
      "    report('the figure did not start', e);",
      '  }',
      '})();'
    );
    return s.join('\n');
  }

  function buildHtml(opts) {
    var figure = JSON.parse(JSON.stringify(opts.figure));
    /* The page is transparent, and a blob URL from the studio means nothing
     * in a folder on someone else's machine. */
    delete figure.background;
    delete figure.backgroundZoom;
    delete figure.sources;

    var logo = opts.logo || null;
    var credit = textOf(opts.credit);
    var name = displayName(opts.name);
    var license = opts.license === 'CC-BY-4.0' ? 'CC BY 4.0' : '';
    var config = {
      startState: startStateOf(opts),
      logo: logo ? logoBox(figure, logo) : null
    };

    var head = [
      '<!doctype html>',
      '<!--',
      '  ' + htmlText(name) + ' for OBS Studio. Open this file as a Browser source with "Local file".',
      credit ? '  Figure: ' + htmlText(name) + ' by ' + htmlText(credit) + (license ? ', ' + license + ' (see LICENSE.txt)' : '') + '.' : '',
      '  Player code: idle-web-animation, Copyright (c) 2026 Daniel Broening, MIT License.',
      opts.date ? '  Built ' + opts.date + '.' : '',
      '-->',
      '<html lang="de">',
      '<head>',
      '<meta charset="utf-8">',
      credit ? '<meta name="author" content="' + htmlText(credit) + '">' : '',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>' + htmlText(name) + '</title>',
      '<style>',
      tagSafe('style', stripCss(opts.sources.idleCss)),
      '</style>',
      '<style>',
      /* An OBS Browser source paints straight onto the scene: anything but the
       * figure would show as a rectangle. */
      'html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }',
      '#host { position: absolute; top: 0; right: 0; bottom: 0; left: 0; }',
      logo ? tagSafe('style', logoCss(logo, glowPeriodOf(figure, logo))) : '',
      '</style>',
      '</head>',
      '<body>',
      '<div id="host"></div>',
      '<script type="application/json" id="idle-figure">' + tagSafe('script', jsonForScript(figure)) + '</script>',
      '<script type="application/json" id="idle-obs-config">' + tagSafe('script', jsonForScript(config)) + '</script>',
      '<script>',
      tagSafe('script', stripJs(opts.sources.idleJs)),
      '</script>',
      '<script>',
      tagSafe('script', stripJs(opts.sources.sceneJs)),
      '</script>',
      '<script>',
      tagSafe('script', pageScript(!!logo)),
      '</script>',
      '</body>',
      '</html>',
      ''
    ];
    var lines = [];
    for (var i = 0; i < head.length; i++) if (head[i] !== '') lines.push(head[i]);
    return lines.join('\n') + '\n';
  }

  /* The tokenizer is written for this repo's sources. If a future idle.js
   * ever defeats it, fail the build loudly instead of shipping a page whose
   * script ends early. Checked per piece, before joining: once joined, an
   * early "</script" looks exactly like the real end of the block.
   *
   * In script data "</script" is the only closer, and "<!--" is the way into
   * the escaped state where a later "<script" can swallow the real closer.
   * <style> is RAWTEXT: only "</style" ends it. */
  function tagSafe(kind, text) {
    var bad = kind === 'style' ? /<\/style/i : /<\/script|<!--/i;
    if (bad.test(text)) {
      throw new Error('package.js: an inline ' + kind + ' block still contains a sequence that ends it early');
    }
    return text;
  }

  /* ------------------------------------------------------------------ *
   * ANLEITUNG.txt and LICENSE.txt
   * ------------------------------------------------------------------ */

  function creditLine(opts) {
    var credit = textOf(opts.credit);
    if (!credit) return '';
    return 'Figur: ' + displayName(opts.name) + ' von ' + credit +
      (opts.license === 'CC-BY-4.0' ? ', CC BY 4.0' : '');
  }

  function buildGuide(opts) {
    var name = displayName(opts.name);
    var size = figureSize(opts.figure);
    var names = stateNamesOf(opts.figure);
    var start = startStateOf(opts);
    var logo = opts.logo || null;
    var hasLicense = opts.license === 'CC-BY-4.0';
    var credit = creditLine(opts);
    var moods = names.slice(1);
    var t = [];

    t.push(name + ' in OBS', '');
    if (opts.date) t.push('Paket gebaut am ' + opts.date + '.', '');

    t.push('WAS IN DIESEM ORDNER LIEGT', '');
    t.push('obs.html       die Figur. Diese Datei öffnest du in OBS.');
    t.push('layers         die Bilder der Figur.');
    if (logo) t.push(logo.file + (logo.file.length < 14 ? new Array(15 - logo.file.length).join(' ') : ' ') + ' das Logo.');
    t.push('ANLEITUNG.txt  diese Anleitung.');
    if (hasLicense) t.push('LICENSE.txt    die Lizenz der Bilder.');
    t.push('');
    t.push('Wichtig:');
    t.push('Entpacke die ZIP-Datei zuerst.');
    t.push('Lass alle Dateien zusammen in einem Ordner.');
    t.push('Verschiebe obs.html nie allein.');
    t.push('Die Seite sucht die Bilder direkt neben sich.');
    t.push('Leg den Ordner an einen festen Platz, zum Beispiel');
    t.push('Dokumente\\OBS\\' + name.replace(/[^A-Za-z0-9._-]+/g, '-') + '.');
    t.push('');

    t.push('IN OBS EINBINDEN (OBS 28 ODER NEUER)', '');
    t.push('1. Klicke unter "Quellen" (Sources) auf das Plus.');
    t.push('2. Wähle "Browser".');
    t.push('3. Gib einen Namen ein, zum Beispiel "' + name + '".');
    t.push('   Klicke auf "OK".');
    t.push('4. Setze den Haken bei "Lokale Datei" (Local file).');
    t.push('5. Klicke auf "Durchsuchen" (Browse).');
    t.push('   Wähle obs.html aus diesem Ordner.');
    t.push('6. Breite (Width): ' + size.width);
    t.push('7. Höhe (Height): ' + size.height);
    t.push('8. Kein Haken bei "Quelle herunterfahren, wenn nicht sichtbar"');
    t.push('   (Shutdown source when not visible).');
    t.push('9. Kein Haken bei "Browser aktualisieren, wenn Szene aktiv wird"');
    t.push('   (Refresh browser when scene becomes active).');
    t.push('10. Klicke auf "OK".');
    t.push('');
    t.push(size.width + ' x ' + size.height + ' ist die echte Größe der Figur.');
    t.push('So bleibt sie scharf.');
    t.push('Den Hintergrund musst du nicht einstellen. Die Seite ist durchsichtig.');
    t.push('Ohne die zwei Haken startet die Figur nicht bei jedem Szenenwechsel neu.');
    t.push('');

    t.push('STIMMUNGEN', '');
    if (moods.length) {
      t.push('Diese Figur kennt diese Stimmungen:');
      t.push(names.join(', '));
      t.push('');
      t.push('Sie startet mit: ' + start);
      t.push('');
      t.push('Steht eine Stimmung als Wort im Namen einer Szene,');
      t.push('wechselt die Figur in diese Stimmung.');
      t.push('Groß- und Kleinschreibung ist egal.');
      t.push('');
      t.push('Beispiele:');
      t.push('  Szene "Pause ' + moods[0] + '"  ->  ' + moods[0]);
      if (moods.length > 1) t.push('  Szene "Just Chatting ' + moods[1] + '"  ->  ' + moods[1]);
      t.push('  Szene "Game"  ->  ' + start + ' (kein Stimmungswort)');
      t.push('');
      t.push('Seitenberechtigung:');
      t.push('Damit die Figur die Szene schon beim Start kennt,');
      t.push('öffne die Eigenschaften der Browser-Quelle.');
      t.push('Stelle bei "Seitenberechtigungen" (Page permissions)');
      t.push('mindestens "Read access to user information" ein.');
      t.push('Ohne das wechselt die Stimmung erst beim nächsten Szenenwechsel.');
    } else {
      t.push('Diese Figur hat nur die Stimmung "neutral".');
      t.push('Szenennamen ändern an ihr nichts.');
    }
    t.push('');

    if (credit) {
      t.push('NAMENSNENNUNG', '');
      if (hasLicense) {
        t.push('Die Bilder der Figur stehen unter CC BY 4.0.');
        t.push('Du darfst sie zeigen, auch im Stream mit Einnahmen.');
        t.push('Dafür nennst du den Urheber. Kopiere diesen Satz');
        t.push('in die Stream-Beschreibung, ein Panel oder den Abspann:');
      } else {
        t.push('Bitte nenne den Urheber der Figur, zum Beispiel');
        t.push('in der Stream-Beschreibung, einem Panel oder im Abspann:');
      }
      t.push('');
      t.push('  ' + credit);
      t.push('');
      if (hasLicense) {
        t.push('Lizenz: ' + LICENSE_URL);
        if (logo) t.push('Das Logo gehört nicht zur Lizenz. Es bleibt das Zeichen seines Inhabers.');
        t.push('Mehr dazu in LICENSE.txt.');
        t.push('');
      }
    }

    t.push('WENN ETWAS NICHT GEHT', '');
    t.push('Die Quelle bleibt leer:');
    t.push('  Ist die ZIP-Datei entpackt? Liegt der Ordner "layers" neben obs.html?');
    t.push('  Ist der Haken bei "Lokale Datei" gesetzt?');
    t.push('Die Figur ist abgeschnitten oder klein:');
    t.push('  Breite ' + size.width + ' und Höhe ' + size.height + ' eintragen, wie oben.');
    t.push('Die Figur startet bei jedem Szenenwechsel neu:');
    t.push('  Die zwei Haken aus Schritt 8 und 9 entfernen.');
    if (moods.length) {
      t.push('Die Stimmung wechselt nicht:');
      t.push('  Steht das Wort genau so im Szenennamen? "' + moods[0] + '-ish" zählt nicht.');
      t.push('  Seitenberechtigung prüfen, siehe oben.');
    }
    if (logo) {
      t.push('Das Logo fehlt:');
      t.push('  Liegt ' + logo.file + ' neben obs.html?');
    }
    t.push('Nichts bewegt sich:');
    t.push('  OBS 28 oder neuer? Hilfe > Über (Help > About).');
    t.push('  In den Eigenschaften der Quelle auf');
    t.push('  "Cache der aktuellen Seite aktualisieren" (Refresh cache of current page) klicken.');
    t.push('');

    return t.join('\r\n') + '\r\n';
  }

  function buildLicense(opts) {
    var name = displayName(opts.name);
    var credit = textOf(opts.credit);
    var logo = opts.logo || null;
    var t = [];
    t.push(name + ' - Lizenz der Bilder / licence of the pictures', '');
    t.push('DEUTSCH', '');
    t.push('Die Bilder dieser Figur (der Ordner "layers") sind von');
    t.push(credit + '.');
    t.push('Sie stehen unter der Lizenz');
    t.push('Creative Commons Namensnennung 4.0 International (CC BY 4.0):');
    t.push('');
    t.push('    ' + LICENSE_URL);
    t.push('');
    t.push('Du darfst sie teilen und verändern, auch kommerziell.');
    t.push('Namensnennung heißt: Nenne ' + credit + ' als Urheber,');
    t.push('nenne die Lizenz mit Link und sag, ob du etwas verändert hast.');
    t.push('');
    t.push('Nicht unter dieser Lizenz:');
    if (logo) {
      t.push('- das Logo (' + logo.file + '). Es ist das Zeichen seines Inhabers');
      t.push('  und steht nicht unter CC BY 4.0, außer der Inhaber sagt es ausdrücklich.');
    }
    t.push('- der Programmcode in obs.html. Er stammt aus idle-web-animation,');
    t.push('  Copyright (c) 2026 Daniel Broening, MIT License.');
    t.push('');
    t.push('ENGLISH', '');
    t.push('The pictures of this figure (the folder "layers") are by');
    t.push(credit + ',');
    t.push('licensed under Creative Commons Attribution 4.0 International (CC BY 4.0):');
    t.push('');
    t.push('    ' + LICENSE_URL);
    t.push('');
    t.push('You may share and adapt them, also commercially.');
    t.push('Attribution means: name ' + credit + ' as the author,');
    t.push('name and link the licence, and say whether you changed anything.');
    t.push('');
    t.push('Not covered by this licence:');
    if (logo) {
      t.push('- the logo (' + logo.file + '). It is its owner\'s mark and is not');
      t.push('  under CC BY 4.0 unless the owner says so.');
    }
    t.push('- the program code in obs.html, from idle-web-animation,');
    t.push('  Copyright (c) 2026 Daniel Broening, MIT License.');
    t.push('');
    return t.join('\r\n') + '\r\n';
  }

  function build(opts) {
    var problems = validate(opts);
    if (problems.length) throw new Error('IdleObsPackage.build: ' + problems.join('; '));
    var files = [
      { name: 'obs.html', text: buildHtml(opts) },
      { name: 'ANLEITUNG.txt', text: buildGuide(opts) }
    ];
    if (opts.license === 'CC-BY-4.0') files.push({ name: 'LICENSE.txt', text: buildLicense(opts) });
    return files;
  }

  var api = {
    build: build,
    validate: validate,
    /* Exposed for the studio's live preview and for tools/test-addons.mjs,
     * so neither has to compute the box or the period a second way. */
    logoBox: logoBox,
    glowPeriod: glowPeriodOf,
    stateNames: stateNamesOf,
    _stripJs: stripJs,
    _stripCss: stripCss
  };

  global.IdleObsPackage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
