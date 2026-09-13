/*
 * Proves IdleObs.matchState and every rule of IdleFace.step behave exactly
 * like the contracts in gates/PLAN.md and gates/L3b-avatar.md say.
 *
 * IdleObs.matchState: case-insensitive word match, first match in scene
 * order wins, a hyphenated word stays one token, and a word that is not a
 * state name never matches by accident. watchScene() and params() are
 * browser-only (they touch window/DOM) and are not exercised here -
 * matchState is the pure part, and the only part that needs to be right in
 * Node as well as in OBS.
 *
 * IdleFace: headAngles() on synthetic rotation matrices, toPointer()'s scale
 * and mirror, smooth()'s time-constant shape, and step()'s hysteresis,
 * face-lost fallback and smile timer - all synthetic observations over
 * simulated time, exactly like a real camera would arrive one detected
 * frame at a time, just without the camera.
 *
 *   node tools/test-addons.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);
const IdleObs = require(join(root, 'addons', 'obs', 'scene.js'));
const IdleFace = require(join(root, 'addons', 'obs', 'face.js'));

let checks = 0;
let failures = 0;

function check(label, actual, expected) {
  checks++;
  if (actual !== expected) {
    failures++;
    console.error('FEHLER: ' + label + ' -> ' + JSON.stringify(actual) +
      ', erwartet ' + JSON.stringify(expected));
  }
}

function checkClose(label, actual, expected, eps) {
  checks++;
  const e = typeof eps === 'number' ? eps : 1e-6;
  if (typeof actual !== 'number' || !isFinite(actual) || Math.abs(actual - expected) > e) {
    failures++;
    console.error('FEHLER: ' + label + ' -> ' + JSON.stringify(actual) +
      ', erwartet nahe ' + JSON.stringify(expected));
  }
}

const STATES = ['sad', 'happy', 'neutral'];

check('"Pause sad" finds the mood word', IdleObs.matchState('Pause sad', STATES, 'fallback'), 'sad');
check('matching is case-insensitive', IdleObs.matchState('PAUSE SAD', STATES, 'fallback'), 'sad');
check('a scene with no mood word falls back', IdleObs.matchState('Game', STATES, 'fallback'), 'fallback');
check('"sad-ish" is one word, not "sad"', IdleObs.matchState('sad-ish', STATES, 'fallback'), 'fallback');
check('the mood word can sit anywhere in the name', IdleObs.matchState('Just Chatting happy', STATES, 'fallback'), 'happy');
check('the first matching word wins', IdleObs.matchState('happy sad', STATES, 'fallback'), 'happy');
check('an empty scene name falls back', IdleObs.matchState('', STATES, 'fallback'), 'fallback');
check('an undefined scene name falls back', IdleObs.matchState(undefined, STATES, 'fallback'), 'fallback');
check('words that are not state names never match', IdleObs.matchState('xyz abc', STATES, 'fallback'), 'fallback');
check('"neutral" matches when it is a listed state', IdleObs.matchState('BRB neutral break', STATES, 'fallback'), 'neutral');
check('no state list at all still falls back', IdleObs.matchState('sad', [], 'fallback'), 'fallback');

/* ------------------------------------------------------------------ *
 * IdleFace.headAngles: synthetic rotation matrices, built the same
 * column-major way MediaPipe's Matrix.data is documented to be laid out
 * (see the comment in addons/obs/face.js). A matrix built for a chosen
 * angle has to come back as that angle - that is what "internally
 * consistent" means for a formula nobody has pointed a real camera at yet.
 * ------------------------------------------------------------------ */

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/* Rotation about Y (yaw), column-major: col0 = [c,0,-s], col1 = [0,1,0],
 * col2 = [s,0,c]. */
function yawMatrix(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

/* Rotation about X (pitch), column-major: col0 = [1,0,0], col1 = [0,c,s],
 * col2 = [0,-s,c]. */
function pitchMatrix(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

const idAngles = IdleFace.headAngles(identityMatrix());
checkClose('identity matrix: yaw is 0', idAngles.yaw, 0);
checkClose('identity matrix: pitch is 0', idAngles.pitch, 0);

for (const deg of [0, 10, -15, 24.9]) {
  const a = IdleFace.headAngles(yawMatrix(deg));
  checkClose('yaw matrix ' + deg + ' deg -> yaw', a.yaw, deg, 1e-3);
  checkClose('yaw matrix ' + deg + ' deg -> pitch stays 0', a.pitch, 0, 1e-3);
}

for (const deg of [0, 12, -8]) {
  const a = IdleFace.headAngles(pitchMatrix(deg));
  checkClose('pitch matrix ' + deg + ' deg -> pitch', a.pitch, deg, 1e-3);
  checkClose('pitch matrix ' + deg + ' deg -> yaw stays 0', a.yaw, 0, 1e-3);
}

const junk = IdleFace.headAngles([NaN, undefined, 'x']);
check('a malformed matrix still yields a finite yaw', isFinite(junk.yaw), true);
check('a malformed matrix still yields a finite pitch', isFinite(junk.pitch), true);

/* ------------------------------------------------------------------ *
 * IdleFace.toPointer: 25 degrees is full deflection, clamped past that,
 * mirror flips X only - Y is never mirrored.
 * ------------------------------------------------------------------ */

check('toPointer: full deflection right, mirrored (the default) -> x = -1',
  IdleFace.toPointer(25, 0, true).x, -1);
check('toPointer: full deflection right, unmirrored -> x = 1',
  IdleFace.toPointer(25, 0, false).x, 1);
check('toPointer: beyond full deflection still clamps to 1',
  IdleFace.toPointer(50, 0, false).x, 1);
checkClose('toPointer: half deflection left, unmirrored -> x = -0.5',
  IdleFace.toPointer(-12.5, 0, false).x, -0.5);
checkClose('toPointer: pitch is never mirrored',
  IdleFace.toPointer(0, 12.5, false).y, 0.5);
checkClose('toPointer: pitch is never mirrored (mirror=true changes nothing about y)',
  IdleFace.toPointer(0, 12.5, true).y, 0.5);

/* ------------------------------------------------------------------ *
 * IdleFace.smooth: an exponential filter with a time constant, not a
 * fixed-per-frame lerp - the same distance covered in the same wall-clock
 * time regardless of the calling frame rate.
 * ------------------------------------------------------------------ */

check('smooth: the very first call jumps straight to the target (no prior state to ease from)',
  IdleFace.smooth(undefined, 1, 0, 0.12), 1);
check('smooth: zero elapsed time means zero movement',
  IdleFace.smooth(0, 1, 0, 0.12), 0);
checkClose('smooth: one time constant covers 1 - 1/e of the distance',
  IdleFace.smooth(0, 1, 0.12, 0.12), 1 - Math.exp(-1), 1e-9);
check('smooth: a long gap (a backgrounded tab) still lands close to the target, not past it',
  IdleFace.smooth(0, 1, 100, 0.12) > 0.999 && IdleFace.smooth(0, 1, 100, 0.12) <= 1, true);

/* ------------------------------------------------------------------ *
 * IdleFace.step: hysteresis edges, the 1 s face-lost fallback, the smile
 * timer, a scene change mid-smile, and a figure with no "happy" mood.
 * Each block is its own tiny simulated session, `mem` threaded from one
 * step() call to the next exactly like avatar.html threads it.
 * ------------------------------------------------------------------ */

function obs(yaw, pitch, blendshapes) {
  return { yaw: yaw, pitch: pitch, blendshapes: blendshapes || {} };
}

/* Blink: both eyes have to be closed, with hysteresis on the lesser of the
 * two scores, so one flaky landmark or a wink cannot flutter the lids. */
(function () {
  let mem = {};
  const opt = { mirror: false, hasHappy: false, baseMood: 'neutral' };
  let r;

  r = IdleFace.step(mem, obs(0, 0, { eyeBlinkLeft: 0.5, eyeBlinkRight: 0.5 }), 0, opt);
  mem = r.memory;
  check('blink: at 0.5/0.5, below the close threshold, stays open', r.blink, 0);

  r = IdleFace.step(mem, obs(0, 0, { eyeBlinkLeft: 0.6, eyeBlinkRight: 0.6 }), 0.03, opt);
  mem = r.memory;
  check('blink: both eyes above 0.55 closes', r.blink, 1);

  r = IdleFace.step(mem, obs(0, 0, { eyeBlinkLeft: 0.5, eyeBlinkRight: 0.9 }), 0.06, opt);
  mem = r.memory;
  check('blink: inside the hysteresis band (one eye at 0.5) stays closed, no chatter', r.blink, 1);

  r = IdleFace.step(mem, obs(0, 0, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.3 }), 0.09, opt);
  mem = r.memory;
  check('blink: one eye drops below 0.45 opens - BOTH have to stay closed', r.blink, 0);
})();

/* Mouth: same hysteresis shape, no schedule to fall back to. */
(function () {
  let mem = {};
  const opt = { mirror: false, hasHappy: false, baseMood: 'neutral' };
  let r;

  r = IdleFace.step(mem, obs(0, 0, { jawOpen: 0.3 }), 0, opt);
  mem = r.memory;
  check('mouth: 0.3 is below the open threshold, stays closed', r.mouth, 0);

  r = IdleFace.step(mem, obs(0, 0, { jawOpen: 0.4 }), 0.03, opt);
  mem = r.memory;
  check('mouth: above 0.35 opens', r.mouth, 1);

  r = IdleFace.step(mem, obs(0, 0, { jawOpen: 0.3 }), 0.06, opt);
  mem = r.memory;
  check('mouth: inside the hysteresis band stays open', r.mouth, 1);

  r = IdleFace.step(mem, obs(0, 0, { jawOpen: 0.2 }), 0.09, opt);
  mem = r.memory;
  check('mouth: below 0.25 closes', r.mouth, 0);
})();

/* The 1 s face-lost fallback: blink hands the schedule back, mouth closes,
 * and the pointer eases to 0 rather than snapping there. */
(function () {
  let mem = {};
  const opt = { mirror: false, hasHappy: false, baseMood: 'neutral' };
  let r;

  r = IdleFace.step(mem, obs(20, 0, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9, jawOpen: 0.5 }), 0, opt);
  mem = r.memory;
  check('face seen: blink is a number while tracked', r.blink, 1);
  check('face seen: mouth is a number while tracked', r.mouth, 1);

  r = IdleFace.step(mem, null, 0.5, opt);
  mem = r.memory;
  check('face lost under 1s: blink holds its last reading', r.blink, 1);
  check('face lost under 1s: mouth holds its last reading', r.mouth, 1);
  check('face lost under 1s: pointer still leans toward the last heading, not centred',
    r.pointerX !== 0, true);

  r = IdleFace.step(mem, null, 1.01, opt);
  mem = r.memory;
  check('face lost over 1s: blink hands the schedule back (undefined)', r.blink, undefined);
  check('face lost over 1s: mouth closes', r.mouth, 0);

  r = IdleFace.step(mem, null, 3, opt);
  check('face lost long enough: pointer has eased back to 0', Math.abs(r.pointerX) < 1e-3, true);
})();

/* A fresh call with nothing at all - no camera has ever produced a frame -
 * defaults to the figure's own idle schedule immediately, not after a fake
 * first second. */
(function () {
  const r = IdleFace.step({}, null, 0, {});
  check('never seen a face: mood defaults to neutral', r.mood, 'neutral');
  check('never seen a face: blink is undefined (own schedule) from the first call', r.blink, undefined);
  check('never seen a face: mouth is closed from the first call', r.mouth, 0);
})();

/* The smile timer: held 0.5 s switches to happy, a scene change mid-smile
 * updates the base mood without interrupting it, and 1.5 s without a smile
 * returns to whatever the base mood now is. */
(function () {
  let mem = {};
  const smile = { mouthSmileLeft: 0.8, mouthSmileRight: 0.8 };
  const noSmile = { mouthSmileLeft: 0.1, mouthSmileRight: 0.1 };
  let r;

  r = IdleFace.step(mem, obs(0, 0, smile), 0, { mirror: false, hasHappy: true, baseMood: 'neutral' });
  mem = r.memory;
  check('smile just started: mood has not switched yet', r.mood, 'neutral');

  r = IdleFace.step(mem, obs(0, 0, smile), 0.49, { mirror: false, hasHappy: true, baseMood: 'neutral' });
  mem = r.memory;
  check('smile held 0.49s: still not enough', r.mood, 'neutral');

  r = IdleFace.step(mem, obs(0, 0, smile), 0.5, { mirror: false, hasHappy: true, baseMood: 'neutral' });
  mem = r.memory;
  check('smile held 0.5s: switches to happy', r.mood, 'happy');

  r = IdleFace.step(mem, obs(0, 0, smile), 0.7, { mirror: false, hasHappy: true, baseMood: 'sad' });
  mem = r.memory;
  check('scene changes to "sad" while still smiling: the smile still wins', r.mood, 'happy');

  r = IdleFace.step(mem, obs(0, 0, noSmile), 0.8, { mirror: false, hasHappy: true, baseMood: 'sad' });
  mem = r.memory;
  check('smile lets go: happy holds through the release grace period', r.mood, 'happy');

  r = IdleFace.step(mem, obs(0, 0, noSmile), 0.8 + 1.49, { mirror: false, hasHappy: true, baseMood: 'sad' });
  mem = r.memory;
  check('1.49s without a smile: still happy', r.mood, 'happy');

  /* 1.51s rather than the exact 1.5s boundary: floating-point addition of
   * 0.8 + 1.5 lands a hair under 1.5 once subtracted back out (1.4999999999999998
   * in this Node), which would fail this check for a reason that has
   * nothing to do with the rule under test. The 0.49s/0.5s pair above
   * already proves the boundary itself is honoured. */
  r = IdleFace.step(mem, obs(0, 0, noSmile), 0.8 + 1.51, { mirror: false, hasHappy: true, baseMood: 'sad' });
  mem = r.memory;
  check('over 1.5s without a smile: back to the base mood - "sad", since the scene changed while happy', r.mood, 'sad');
})();

/* A figure with no "happy" mood at all never switches, however long the
 * smile is held. */
(function () {
  let mem = {};
  const smile = { mouthSmileLeft: 0.9, mouthSmileRight: 0.9 };
  const opt = { mirror: false, hasHappy: false, baseMood: 'neutral' };

  let r = IdleFace.step(mem, obs(0, 0, smile), 0, opt);
  mem = r.memory;
  r = IdleFace.step(mem, obs(0, 0, smile), 5, opt);
  check('a figure without "happy" never switches, however long the smile', r.mood, 'neutral');
})();

/* ------------------------------------------------------------------ *
 * IdleObsPackage: the OBS package builder (gates/PLAN-obs-package.md).
 *
 * The page it writes is opened by someone with no repo and no server, so
 * everything that can break there is proven here on the strings: the names
 * of the files, that nothing reaches for the network, that the figure JSON
 * survives the trip through a <script> tag even with "</script>" in a layer
 * id, that every inline script parses, and what the page script does when it
 * runs against a stand-in for the DOM and the player.
 * ------------------------------------------------------------------ */

const IdleObsPackage = require(join(root, 'addons', 'obs', 'package.js'));
const Idle = require(join(root, 'player', 'idle.js'));

const EVIL = '</script><script>alert(1)</script>';
const pedro = JSON.parse(readFileSync(join(root, 'figures', 'pedro', 'figure.json'), 'utf8'));
delete pedro.background;
/* The studio's export drops backgroundZoom along with the background, and
 * the builder does too, so the round trip compares against a figure without. */
delete pedro.backgroundZoom;
const SOURCES = {
  idleJs: readFileSync(join(root, 'player', 'idle.js'), 'utf8'),
  idleCss: readFileSync(join(root, 'player', 'idle.css'), 'utf8'),
  sceneJs: readFileSync(join(root, 'addons', 'obs', 'scene.js'), 'utf8')
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function baseOpts(extra) {
  return Object.assign({
    name: 'pedro',
    figure: clone(pedro),
    sources: SOURCES,
    logo: { file: 'logo.webp', aspect: 1948 / 1208, x: 0.62, y: 0.8, width: 0.34, wipe: true, glow: true, gleam: true, inFigure: true },
    startState: 'neutral',
    credit: 'Max Muster (@maxmuster)',
    license: 'CC-BY-4.0',
    date: '2026-09-13'
  }, extra || {});
}

function fileOf(files, name) {
  for (const f of files) if (f.name === name) return f.text;
  return undefined;
}

function jsonBlock(html, id) {
  const m = html.match(new RegExp('<script type="application/json" id="' + id + '">([\\s\\S]*?)</script>'));
  return m ? JSON.parse(m[1]) : undefined;
}

function plainScripts(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function throws(fn) {
  try { fn(); return false; } catch (e) { return true; }
}

/* Run the page's own script against stand-ins, and record what it did. */
function runPage(html, sceneName) {
  const log = { calls: [], appended: [], ctor: null, listeners: [] };
  const els = {};
  function el(tag) {
    return {
      tag: tag, className: '', style: {}, attrs: {}, children: [],
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); return c; }
    };
  }
  const stage = el('div');
  stage.appendChild = function (c) { log.appended.push(c); this.children.push(c); return c; };
  els['idle-figure'] = { textContent: html.match(/id="idle-figure">([\s\S]*?)<\/script>/)[1] };
  els['idle-obs-config'] = { textContent: html.match(/id="idle-obs-config">([\s\S]*?)<\/script>/)[1] };
  els.host = el('div');
  const document = {
    getElementById(id) { return els[id] || null; },
    createElement(tag) { return el(tag); }
  };
  function IdleFigure(host, fig, base, opts) {
    log.ctor = { host: host, fig: fig, base: base, opts: opts };
    this.stage = stage;
    log.calls.push('new');
  }
  IdleFigure.prototype.setState = function (n) { log.calls.push('setState:' + n); return true; };
  IdleFigure.prototype.play = function () { log.calls.push('play'); };
  IdleFigure.prototype.fit = function () { log.calls.push('fit'); };
  IdleFigure.prototype.trackPointer = function () { log.calls.push('trackPointer'); };
  const IdleObsStub = {
    matchState: IdleObs.matchState,
    watchScene(cb) { log.calls.push('watchScene'); if (sceneName !== undefined) cb(sceneName); }
  };
  const errors = [];
  const window = {
    IdleObs: IdleObsStub,
    console: { error(...a) { errors.push(a.join(' ')); } },
    addEventListener(type) { log.listeners.push(type); }
  };
  const body = plainScripts(html)[2];
  new Function('window', 'document', 'IdleFigure', 'Idle', 'IdleObs', 'console', body)(
    window, document, IdleFigure, Idle, IdleObsStub, window.console);
  log.errors = errors;
  return log;
}

(function () {
  const opts = baseOpts();
  check('validate(): the pedro proof options have no problems', JSON.stringify(IdleObsPackage.validate(opts)), '[]');

  const files = IdleObsPackage.build(opts);
  check('build(): obs.html, logo.html, ANLEITUNG.txt, LICENSE.txt in that order',
    files.map((f) => f.name).join(','), 'obs.html,logo.html,ANLEITUNG.txt,LICENSE.txt');
  check('build(): the same opts give the same bytes',
    JSON.stringify(IdleObsPackage.build(baseOpts())), JSON.stringify(files));

  const html = fileOf(files, 'obs.html');
  check('obs.html: no fetch(', /fetch\(/.test(html), false);
  check('obs.html: no http(s) URL', /https?:\/\//i.test(html), false);
  check('obs.html: no src="../', /src="\.\.\//.test(html), false);
  check('obs.html: no external script or stylesheet tag', /<script[^>]+src=|<link[^>]+stylesheet/i.test(html), false);
  check('obs.html: the background is never packed', /background\.webp/.test(html), false);
  check('obs.html: the player is built without a background, from its own folder',
    html.indexOf("new IdleFigure(host, fig, '', { background: false })") >= 0, true);
  check('obs.html: no trackPointer call', /\.trackPointer\(/.test(plainScripts(html)[2]), false);
  check('obs.html: fits on resize', html.indexOf('player.fit()') >= 0, true);

  const fig = jsonBlock(html, 'idle-figure');
  check('figure JSON round-trips from the page', JSON.stringify(fig), JSON.stringify(pedro));
  check('figure JSON: 35 layers', fig.layers.length, 35);

  const scripts = plainScripts(html);
  check('obs.html: three plain inline scripts (idle.js, scene.js, page)', scripts.length, 3);
  scripts.forEach((s, i) => {
    check('inline script ' + i + ' parses', throws(() => new Function(s)), false);
  });

  /* The inlined idle.js has its comments stripped; it must still be the
   * same engine, not just valid syntax. */
  const mod = { exports: {} };
  new Function('module', scripts[0])(mod);
  let same = true;
  for (let t = 0; t < 40; t += 0.173) {
    for (const st of ['neutral', 'sad', 'happy']) {
      const a = JSON.stringify(mod.exports.solve(pedro, t, { state: st, pointerX: 0.3, pointerY: -0.2 }));
      const b = JSON.stringify(Idle.solve(pedro, t, { state: st, pointerX: 0.3, pointerY: -0.2 }));
      if (a !== b) same = false;
    }
  }
  check('inlined idle.js solves pedro exactly like player/idle.js', same, true);
  const sceneMod = { exports: {} };
  new Function('module', scripts[1])(sceneMod);
  check('inlined scene.js still matches scene names', sceneMod.exports.matchState('Pause SAD', ['neutral', 'sad'], 'neutral'), 'sad');

  /* The page script, run against stand-ins. */
  const run = runPage(html, 'Just Chatting happy');
  check('page: player built with background: false', run.ctor && run.ctor.opts.background, false);
  check('page: base url is the page folder', run.ctor && run.ctor.base, '');
  check('page: start mood is set before play(), then the scene mood',
    run.calls.join(','), 'new,setState:neutral,play,watchScene,setState:happy');
  check('page: resize listener', run.listeners.join(','), 'resize');
  check('page: no console errors', run.errors.length, 0);
  check('page: one element appended into the stage', run.appended.length, 1);
  const logoEl = run.appended[0] || { style: {}, children: [] };
  const W = 1792, H = 1000, w = 0.34 * W, h = w / (1948 / 1208);
  check('page: the logo element carries only the class "logo"', logoEl.className, 'logo');
  check('page: .logo-inner inside it', logoEl.children[0] && logoEl.children[0].className, 'logo-inner');
  checkClose('logo box: left = x*W - w/2', parseFloat(logoEl.style.left), 0.62 * W - w / 2, 0.001);
  checkClose('logo box: top = y*H - h/2', parseFloat(logoEl.style.top), 0.8 * H - h / 2, 0.001);
  checkClose('logo box: width = width*W', parseFloat(logoEl.style.width), w, 0.001);
  checkClose('logo box: height = w / aspect', parseFloat(logoEl.style.height), h, 0.001);
  check('logo box: written in px', /px$/.test(logoEl.style.left) && /px$/.test(logoEl.style.height), true);

  check('logo CSS: background-image and both mask-images use the file',
    html.indexOf("background-image: url('logo.webp')") >= 0 &&
    html.indexOf("-webkit-mask-image: url('logo.webp')") >= 0 &&
    html.indexOf("mask-image: url('logo.webp')") >= 0, true);
  check('logo CSS: wipe, sheen, breath, gleam', ['logoWipe', 'logoSheen', 'logoAtem', 'logoGleam']
    .every((k) => html.indexOf('@keyframes ' + k) >= 0), true);
  check('logo CSS: glow period is the first breathe period (pedro torso: 4)',
    html.indexOf('animation: logoAtem 4s ease-in-out infinite') >= 0, true);
  check('logo CSS: gleam starts 2 s after the wipe', html.indexOf('logoGleam 9s ease-in-out 4.9s infinite') >= 0, true);
  check('logo CSS: prefers-reduced-motion block', html.indexOf('@media (prefers-reduced-motion: reduce)') >= 0, true);
  check('logo CSS: -webkit- mask properties for Chromium 103', /-webkit-mask-position: 100% 50%/.test(html), true);

  /* Credit: in the top comment and the author meta, nowhere else. */
  const credit = 'Max Muster (@maxmuster)';
  const top = html.match(/^<!doctype html>\n<!--[\s\S]*?-->/);
  check('credit: in the top comment', !!top && top[0].indexOf(credit) >= 0, true);
  check('credit: in <meta name="author">', html.indexOf('<meta name="author" content="' + credit + '">') >= 0, true);
  const rest = html.replace(top[0], '').replace('<meta name="author" content="' + credit + '">', '');
  check('credit: nowhere else in obs.html', rest.indexOf('maxmuster') >= 0 || rest.indexOf('Max Muster') >= 0, false);

  const guide = fileOf(files, 'ANLEITUNG.txt');
  check('ANLEITUNG.txt: real width', guide.indexOf('Breite (Width): 1792') >= 0, true);
  check('ANLEITUNG.txt: real height', guide.indexOf('Höhe (Height): 1000') >= 0, true);
  for (const s of Idle.stateNames(pedro)) {
    check('ANLEITUNG.txt: names the mood "' + s + '"', new RegExp('\\b' + s + '\\b').test(guide), true);
  }
  check('ANLEITUNG.txt: credit sentence to copy', guide.indexOf('Figur: Pedro von Max Muster (@maxmuster), CC BY 4.0') >= 0, true);
  check('ANLEITUNG.txt: Local file', guide.indexOf('Lokale Datei') >= 0, true);

  const lic = fileOf(files, 'LICENSE.txt');
  check('LICENSE.txt: credit and licence URL', lic.indexOf(credit) >= 0 && lic.indexOf('https://creativecommons.org/licenses/by/4.0/') >= 0, true);
  check('LICENSE.txt: the logo is not under CC BY', /logo\.webp\)\. Es ist das Zeichen seines Inhabers/.test(lic), true);
})();

/* A layer id and an alt text that try to close the tag. */
(function () {
  const figure = clone(pedro);
  figure.layers[0].id = EVIL;
  figure.layers[0].alt = EVIL + '<!--';
  figure.note = '<!-- <script> ' + EVIL;
  const html = fileOf(IdleObsPackage.build(baseOpts({ figure: figure, name: 'evil ' + EVIL })), 'obs.html');
  check('escaping: the evil figure JSON still round-trips', JSON.stringify(jsonBlock(html, 'idle-figure')), JSON.stringify(figure));
  check('escaping: exactly five <script> openers', (html.match(/<script/gi) || []).length, 5);
  check('escaping: exactly five </script closers', (html.match(/<\/script/gi) || []).length, 5);
  check('escaping: exactly two </style closers', (html.match(/<\/style/gi) || []).length, 2);
  check('escaping: no <!-- after the top comment', html.indexOf('<!--', 20), -1);
  check('escaping: the name is text in <title>', html.indexOf('<title>Evil &lt;/script&gt;') >= 0, true);
  check('escaping: no alert( outside the JSON-escaped block',
    html.replace(/id="idle-figure">[\s\S]*?<\/script>/, '').replace(/<title>[\s\S]*?<\/title>/, '').replace(/^<!doctype html>\n<!--[\s\S]*?-->/, '').indexOf('alert(1)'), -1);

  /* Sources carrying the sequences inside literals and comments. */
  const js = "/* </script> */ var a = '</script><!--'; var b = \"</SCRIPT>\"; var r = /<\\/script>|</g; // </script>\n" +
    "var n = 4 / 2 / 1; var t = `</script>`; module.exports = { a: a, b: b, r: r.source, n: n, t: t };";
  const stripped = IdleObsPackage._stripJs(js);
  check('stripJs: no </script or <!-- left', /<\/script|<!--/i.test(stripped), false);
  const m = { exports: {} };
  new Function('module', stripped)(m);
  const m0 = { exports: {} };
  new Function('module', js)(m0);
  check('stripJs: literals keep their values', JSON.stringify(m.exports), JSON.stringify(m0.exports));
  const css = IdleObsPackage._stripCss('/* </style> */ a::after { content: "</style>"; }');
  check('stripCss: no </style left', /<\/style/i.test(css), false);
  check('stripCss: comment gone, string kept as the same characters', css.indexOf('content: "<\\/style>"') >= 0, true);
  check('build(): a source that cannot be made tag-safe is refused, not shipped',
    throws(() => IdleObsPackage.build(baseOpts({ sources: Object.assign({}, SOURCES, { sceneJs: 'var x = 1 <!-- 2;' }) }))), true);
})();

/* No logo, no licence, no credit, no moods, no breathe. */
(function () {
  const figure = clone(pedro);
  delete figure.states;
  const files = IdleObsPackage.build(baseOpts({ figure: figure, logo: null, license: '', credit: '', startState: '' }));
  const html = fileOf(files, 'obs.html');
  check('no licence: no LICENSE.txt', files.map((f) => f.name).join(','), 'obs.html,ANLEITUNG.txt');
  check('no logo: no logo markup, CSS or code',
    /logo/i.test(html.replace(/id="idle-obs-config">[\s\S]*?<\/script>/, '')), false);
  check('no carriage returns in obs.html, whatever the checkout', /\r/.test(html), false);
  check('no logo: config says null', jsonBlock(html, 'idle-obs-config').logo, null);
  check('no credit: no author meta', /name="author"/.test(html), false);
  check('empty startState means neutral', jsonBlock(html, 'idle-obs-config').startState, 'neutral');
  const run = runPage(html, 'Pause sad');
  check('no moods: a scene word that is no mood falls back to the start mood',
    run.calls.join(','), 'new,setState:neutral,play,watchScene,setState:neutral');
  check('no logo: nothing appended into the stage', run.appended.length, 0);
  const guide = fileOf(files, 'ANLEITUNG.txt');
  check('no moods: ANLEITUNG.txt says so', guide.indexOf('nur die Stimmung "neutral"') >= 0, true);
  check('no credit: ANLEITUNG.txt has no credit section', guide.indexOf('NAMENSNENNUNG'), -1);

  const sad = fileOf(IdleObsPackage.build(baseOpts({ startState: 'sad' })), 'obs.html');
  check('startState lands in the page config', jsonBlock(sad, 'idle-obs-config').startState, 'sad');
  check('startState sad: set before play()', runPage(sad).calls.slice(0, 3).join(','), 'new,setState:sad,play');

  function period(fig, logoExtra) {
    const logo = Object.assign({ file: 'logo.png', aspect: 2, x: 0.5, y: 0.5, width: 0.2, wipe: false, glow: true, gleam: false }, logoExtra || {});
    return IdleObsPackage.glowPeriod(fig, logo);
  }
  const noBreathe = clone(pedro);
  noBreathe.layers.forEach((l) => { l.motions = (l.motions || []).filter((mo) => mo.type !== 'breathe'); });
  check('glow period: pedro, first breathe period', period(pedro), 4);
  check('glow period: no breathe at all falls back to 4.2', period(noBreathe), 4.2);
  const bareBreathe = clone(noBreathe);
  bareBreathe.layers[3].motions.push({ type: 'breathe' });
  bareBreathe.layers[5].motions.push({ type: 'breathe', period: 6 });
  check('glow period: a breathe without a period runs at the engine default 4', period(bareBreathe), 4);
  check('glow period: logo.period wins', period(pedro, { period: 5.5 }), 5.5);
  const glowHtml = fileOf(IdleObsPackage.build(baseOpts({ figure: noBreathe })), 'obs.html');
  check('glow period 4.2 lands in the CSS', glowHtml.indexOf('logoAtem 4.2s') >= 0, true);

  /* Effects switch independently. */
  const plain = fileOf(IdleObsPackage.build(baseOpts({ logo: { file: 'logo.webp', aspect: 1.6, x: 0.5, y: 0.5, width: 0.3, wipe: false, glow: false, gleam: false, inFigure: true } })), 'obs.html');
  check('all effects off: no animation keyframes', /@keyframes logo/.test(plain), false);
  check('wipe off: no mask on .logo-inner, the logo shows from the start', /-webkit-mask-image: linear-gradient/.test(plain), false);
  check('all effects off: the picture is still there', plain.indexOf("background-image: url('logo.webp')") >= 0, true);
  const gleamOnly = fileOf(IdleObsPackage.build(baseOpts({ logo: { file: 'logo.webp', aspect: 1.6, x: 0.5, y: 0.5, width: 0.3, wipe: false, glow: false, gleam: true, inFigure: true } })), 'obs.html');
  check('gleam without wipe: starts after 2 s, no wipe, no breath',
    gleamOnly.indexOf('logoGleam 9s ease-in-out 2s infinite') >= 0 && !/logoWipe|logoAtem/.test(gleamOnly), true);

  /* Logo at the edges: half outside the canvas is allowed. */
  const edge = { file: 'logo.webp', aspect: 2, x: 0, y: 1, width: 1, wipe: true, glow: true, gleam: false };
  check('logo at x=0, y=1, width=1: valid', IdleObsPackage.validate(baseOpts({ logo: edge })).length, 0);
  const box = IdleObsPackage.logoBox(pedro, edge);
  check('logo box at the edge: left', box.left, -896);
  check('logo box at the edge: top', box.top, 1000 - 448);
  check('logo box: default canvas 1000 when size is missing',
    JSON.stringify(IdleObsPackage.logoBox({ layers: [] }, { aspect: 2, x: 0.5, y: 0.5, width: 0.5 })),
    JSON.stringify({ left: 250, top: 375, width: 500, height: 250 }));
})();

/* stateNames copy agrees with the engine. */
(function () {
  const odd = { layers: [{ id: 'a' }], states: { sad: {}, Bad: {}, neutral: {}, '2': {}, happy: [], 'x y': {}, calm: { a: {} } } };
  check('stateNames: same as Idle.stateNames for pedro', JSON.stringify(IdleObsPackage.stateNames(pedro)), JSON.stringify(Idle.stateNames(pedro)));
  check('stateNames: same as Idle.stateNames for odd names', JSON.stringify(IdleObsPackage.stateNames(odd)), JSON.stringify(Idle.stateNames(odd)));
  check('stateNames: no states at all', JSON.stringify(IdleObsPackage.stateNames({ layers: [] })), '["neutral"]');
})();

/* validate() names every bad input, and build() refuses it. */
(function () {
  function problems(extra, logoExtra) {
    const o = baseOpts(extra);
    if (logoExtra) o.logo = Object.assign({}, o.logo, logoExtra);
    return IdleObsPackage.validate(o).join(' | ');
  }
  check('validate: logo width 0', /logo\.width/.test(problems(null, { width: 0 })), true);
  check('validate: logo x above 1', /logo\.x/.test(problems(null, { x: 1.2 })), true);
  check('validate: logo y below 0', /logo\.y/.test(problems(null, { y: -0.1 })), true);
  check('validate: logo y NaN', /logo\.y/.test(problems(null, { y: NaN })), true);
  check('validate: logo aspect missing', /logo\.aspect/.test(problems(null, { aspect: undefined })), true);
  check('validate: logo period 0', /logo\.period/.test(problems(null, { period: 0 })), true);
  check('validate: logo glow not a boolean', /logo\.glow/.test(problems(null, { glow: 'yes' })), true);
  check('validate: non-ascii logo file name', /logo\.file/.test(problems(null, { file: 'lögo.webp' })), true);
  check('validate: logo file name with a space', /logo\.file/.test(problems(null, { file: 'my logo.webp' })), true);
  check('validate: logo file name with a path', /logo\.file/.test(problems(null, { file: '../logo.webp' })), true);
  check('validate: logo file without an image extension', /logo\.file/.test(problems(null, { file: 'logo.html' })), true);
  check('validate: unknown licence', /license/.test(problems({ license: 'MIT' })), true);
  check('validate: CC BY without a credit', /credit/.test(problems({ credit: '' })), true);
  check('validate: unknown startState', /startState "angry"/.test(problems({ startState: 'angry' })), true);
  const noStates = clone(pedro);
  delete noStates.states;
  check('validate: startState sad on a figure without moods', /startState "sad"/.test(problems({ figure: noStates, startState: 'sad' })), true);
  check('validate: bad date', /date/.test(problems({ date: '13.09.2026' })), true);
  check('validate: empty name', /name/.test(problems({ name: '  ' })), true);
  check('validate: missing source', /sourceshit|sources\.sceneJs/.test(problems({ sources: { idleJs: 'x', idleCss: 'y' } })), true);
  check('validate: figure without layers', /layers/.test(problems({ figure: { size: { width: 10, height: 10 } } })), true);
  check('validate: a name with spaces is fine', problems({ name: 'mein pedro' }), '');
  check('validate: no logo is fine', problems({ logo: null }), '');
  check('build(): throws on a problem', throws(() => IdleObsPackage.build(baseOpts({ license: 'MIT' }))), true);
  const spaced = IdleObsPackage.build(baseOpts({ name: 'mein pedro' }));
  check('a name with spaces: title', fileOf(spaced, 'obs.html').indexOf('<title>Mein pedro</title>') >= 0, true);
  check('a name with spaces: credit sentence', fileOf(spaced, 'ANLEITUNG.txt').indexOf('Figur: Mein pedro von Max Muster (@maxmuster), CC BY 4.0') >= 0, true);
  check('validate: logo inFigure not a boolean', /logo\.inFigure/.test(problems(null, { inFigure: 'yes' })), true);
  check('validate: logo inFigure false is fine', problems(null, { inFigure: false }), '');
  check('validate: logo without inFigure is fine', problems(null, { inFigure: undefined }), '');
})();

/* L6 (gates/L6-logo-separate.md): the logo as its own OBS source,
 * logo.inFigure, and a package that names no person for its code. */
(function () {
  const build = IdleObsPackage.build;
  const credit = 'Max Muster (@maxmuster)';
  const onOpts = baseOpts();
  const offLogo = Object.assign({}, onOpts.logo, { inFigure: false });
  const defLogo = Object.assign({}, onOpts.logo);
  delete defLogo.inFigure;
  const filesOn = build(onOpts);
  const filesOff = build(baseOpts({ logo: offLogo }));
  const filesDef = build(baseOpts({ logo: defLogo }));
  const filesNone = build(baseOpts({ logo: null }));

  check('logo, inFigure false: obs.html, logo.html, ANLEITUNG.txt, LICENSE.txt',
    filesOff.map((f) => f.name).join(','), 'obs.html,logo.html,ANLEITUNG.txt,LICENSE.txt');
  check('no logo: no logo.html', filesNone.map((f) => f.name).join(','), 'obs.html,ANLEITUNG.txt,LICENSE.txt');

  /* obs.html carries the logo only with inFigure: true. */
  const htmlOff = fileOf(filesOff, 'obs.html');
  const htmlNone = fileOf(filesNone, 'obs.html');
  check('inFigure false: obs.html is byte for byte the page without a logo', htmlOff, htmlNone);
  check('inFigure missing: obs.html is byte for byte the page without a logo', fileOf(filesDef, 'obs.html'), htmlNone);
  check('inFigure false: no logo markup, CSS or code in obs.html',
    /logo/i.test(htmlOff.replace(/id="idle-obs-config">[\s\S]*?<\/script>/, '')), false);
  check('inFigure false: config logo is null', jsonBlock(htmlOff, 'idle-obs-config').logo, null);
  check('inFigure false: nothing appended into the stage', runPage(htmlOff).appended.length, 0);
  const htmlOn = fileOf(filesOn, 'obs.html');
  check('inFigure true: obs.html has the logo CSS', htmlOn.indexOf('.logo-inner {') >= 0, true);
  check('inFigure true: the page appends the logo', runPage(htmlOn).appended.length, 1);

  /* logo.html */
  const lh = fileOf(filesOff, 'logo.html');
  check('logo.html: the same page whether inFigure is true or false', fileOf(filesOn, 'logo.html'), lh);
  check('logo.html: no <script at all', /<script/i.test(lh), false);
  check('logo.html: no fetch(', /fetch\(/.test(lh), false);
  check('logo.html: no http(s) URL', /https?:\/\//i.test(lh), false);
  check('logo.html: no external stylesheet', /<link/i.test(lh), false);
  check('logo.html: no carriage returns', /\r/.test(lh), false);
  check('logo.html: transparent, margin 0, full height, no scrollbars',
    lh.indexOf('html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }') >= 0, true);
  check('logo.html: 32px inset for the glow on every side',
    lh.indexOf('.logo-frame { position: absolute; top: 32px; right: 32px; bottom: 32px; left: 32px; }') >= 0, true);
  check('logo.html: 3% inset inside it on every side',
    lh.indexOf('.logo-frame .logo { top: 3%; right: 3%; bottom: 3%; left: 3%; }') >= 0, true);
  check('logo.html: only the logo in <body>',
    (lh.match(/<body>\n([\s\S]*?)\n<\/body>/) || [])[1],
    '<div class="logo-frame"><div class="logo" aria-hidden="true"><div class="logo-inner"></div></div></div>');
  const obsLogoCss = (htmlOn.match(/#host \{[^\n]*\}\n([\s\S]*?)\n<\/style>/) || [])[1];
  const pageLogoCss = (lh.match(/\.logo-frame \.logo \{[^\n]*\}\n([\s\S]*?)\n<\/style>/) || [])[1];
  check('logo.html: the logo CSS is exactly the one in obs.html', !!obsLogoCss && pageLogoCss === obsLogoCss, true);
  check('logo.html: background-size contain fits a source of any aspect', lh.indexOf('background-size: contain;') >= 0, true);
  check('logo.html: wipe, sheen, breath, gleam', ['logoWipe', 'logoSheen', 'logoAtem', 'logoGleam']
    .every((k) => lh.indexOf('@keyframes ' + k) >= 0), true);
  check('logo.html: glow period is the first breathe period (4)', lh.indexOf('animation: logoAtem 4s ease-in-out infinite') >= 0, true);
  check('logo.html: gleam starts 2 s after the wipe', lh.indexOf('logoGleam 9s ease-in-out 4.9s infinite') >= 0, true);
  check('logo.html: prefers-reduced-motion block', lh.indexOf('@media (prefers-reduced-motion: reduce)') >= 0, true);
  check('logo.html: -webkit- mask properties for Chromium 103', /-webkit-mask-position: 100% 50%/.test(lh), true);
  check('logo.html: picture from the file next to it', lh.indexOf("background-image: url('logo.webp')") >= 0, true);

  function logoPage(extra, optsExtra) {
    const logo = Object.assign({ file: 'logo.png', aspect: 1.6, x: 0.5, y: 0.5, width: 0.3, wipe: false, glow: false, gleam: false }, extra);
    return fileOf(build(baseOpts(Object.assign({ logo: logo }, optsExtra || {}))), 'logo.html');
  }
  const lPlain = logoPage({});
  check('logo.html, all effects off: no keyframes', /@keyframes/.test(lPlain), false);
  check('logo.html, all effects off: no mask on the picture', /mask-image: linear-gradient/.test(lPlain), false);
  check('logo.html, all effects off: the picture is still there', lPlain.indexOf("background-image: url('logo.png')") >= 0, true);
  const lGleam = logoPage({ gleam: true });
  check('logo.html, gleam without wipe: starts after 2 s, no wipe, no breath',
    lGleam.indexOf('logoGleam 9s ease-in-out 2s infinite') >= 0 && !/logoWipe|logoAtem|logoSheen/.test(lGleam), true);
  const lWipe = logoPage({ wipe: true });
  check('logo.html, wipe only: wipe and sheen, no gleam, no breath',
    /@keyframes logoWipe/.test(lWipe) && /@keyframes logoSheen/.test(lWipe) && !/logoGleam|logoAtem/.test(lWipe), true);
  const lGlow = logoPage({ glow: true, period: 5.5 });
  check('logo.html, glow only: logo.period wins', lGlow.indexOf('animation: logoAtem 5.5s ease-in-out infinite') >= 0 && !/logoWipe|logoGleam/.test(lGlow), true);
  const noBreathe = clone(pedro);
  noBreathe.layers.forEach((l) => { l.motions = (l.motions || []).filter((mo) => mo.type !== 'breathe'); });
  check('logo.html, glow without a breathe: 4.2 s', logoPage({ glow: true }, { figure: noBreathe }).indexOf('logoAtem 4.2s') >= 0, true);
  check('logo.html: the page does not depend on the aspect (contain does the fitting)',
    logoPage({ aspect: 12, wipe: true, glow: true, gleam: true }), logoPage({ aspect: 0.08, wipe: true, glow: true, gleam: true }));
  check('logo.html: reduced motion stops every animation and the wipe mask',
    lh.indexOf('.logo, .logo-inner, .logo-inner::before, .logo-inner::after { animation: none; }') >= 0 &&
    lh.indexOf('.logo-inner { -webkit-mask-image: none; mask-image: none; }') >= 0, true);

  /* Credit in logo.html: comment and author meta, like obs.html. */
  const ltop = lh.match(/^<!doctype html>\n<!--[\s\S]*?-->/);
  check('logo.html credit: in the top comment', !!ltop && ltop[0].indexOf(credit) >= 0, true);
  check('logo.html credit: in <meta name="author">', lh.indexOf('<meta name="author" content="' + credit + '">') >= 0, true);
  const lrest = lh.replace(ltop[0], '').replace('<meta name="author" content="' + credit + '">', '');
  check('logo.html credit: nowhere else', lrest.indexOf('maxmuster') >= 0 || lrest.indexOf('Max Muster') >= 0, false);
  const lNoCredit = logoPage({}, { credit: '', license: '' });
  check('logo.html without credit: no author meta, no Figure line', /name="author"|Figure:/.test(lNoCredit), false);

  /* Tag safety, as for obs.html. */
  const evilLh = fileOf(build(baseOpts({ logo: offLogo, name: 'evil ' + EVIL, credit: 'x --> <style></style> ' + EVIL })), 'logo.html');
  const evilObs = fileOf(build(baseOpts({ name: 'evil ' + EVIL, credit: 'x --> ' + EVIL })), 'obs.html');
  check('logo.html escaping: no <script', /<script/i.test(evilLh), false);
  check('logo.html escaping: exactly one </style closer', (evilLh.match(/<\/style/gi) || []).length, 1);
  check('logo.html escaping: exactly one <style opener', (evilLh.match(/<style/gi) || []).length, 1);
  check('logo.html escaping: no <!-- after the top comment', evilLh.indexOf('<!--', 20), -1);
  check('logo.html escaping: the top comment ends once', (evilLh.match(/-->/g) || []).length, 1);
  check('logo.html escaping: the name is text in <title>', evilLh.indexOf('<title>Evil &lt;/script&gt;') >= 0, true);
  check('obs.html escaping: a credit with --> ends the top comment only once', (evilObs.match(/-->/g) || []).length, 1);

  /* The credit field's text appears exactly, in every file that names it. */
  const guideOff = fileOf(filesOff, 'ANLEITUNG.txt');
  const licOff = fileOf(filesOff, 'LICENSE.txt');
  check('credit exactly: obs.html comment', htmlOff.indexOf('  Figure: Pedro by ' + credit + ', CC BY 4.0 (see LICENSE.txt).') >= 0, true);
  check('credit exactly: logo.html comment', lh.indexOf('  Figure: Pedro by ' + credit + ', CC BY 4.0 (see LICENSE.txt).') >= 0, true);
  check('credit exactly: ANLEITUNG.txt', guideOff.indexOf('  Figur: Pedro von ' + credit + ', CC BY 4.0\r\n') >= 0, true);
  check('credit exactly: LICENSE.txt', licOff.indexOf('\r\n' + credit + '.\r\n') >= 0 && licOff.indexOf('Nenne ' + credit + ' als Urheber') >= 0, true);

  /* No person named for the code, in any file of any build. */
  const outputs = [filesOn, filesOff, filesDef, filesNone,
    build(baseOpts({ credit: '', license: '' })), build(baseOpts({ logo: null, credit: '', license: '' }))];
  let named = false;
  outputs.forEach((fs) => fs.forEach((f) => { if (/broening|bröning|daniel/i.test(f.text)) named = true; }));
  check('no build output names Broening, Bröning or Daniel', named, false);
  check('code notice in obs.html', htmlOff.indexOf('  Player code: idle-web-animation, MIT License.\n') >= 0, true);
  check('code notice in logo.html', lh.indexOf('  Page code: idle-web-animation, MIT License.\n') >= 0, true);
  check('code notice in LICENSE.txt (DE and EN), naming logo.html too',
    licOff.indexOf('- der Programmcode in obs.html und logo.html:\r\n  idle-web-animation, MIT License.') >= 0 &&
    licOff.indexOf('- the program code in obs.html and logo.html:\r\n  idle-web-animation, MIT License.') >= 0, true);
  check('code notice in LICENSE.txt without a logo: obs.html only',
    fileOf(filesNone, 'LICENSE.txt').indexOf('- der Programmcode in obs.html:\r\n  idle-web-animation, MIT License.') >= 0, true);
  check('LICENSE.txt: the logo is still not under CC BY', /logo\.webp\)\. Es ist das Zeichen seines Inhabers/.test(licOff), true);

  /* ANLEITUNG.txt: the logo section. */
  const sec = guideOff.indexOf('DAS LOGO ALS EIGENE QUELLE');
  const after = guideOff.slice(sec);
  const size = IdleObsPackage.logoSourceSize(1948 / 1208);
  check('logoSourceSize: pedro logo 800 x 520', size.width + 'x' + size.height, '800x520');
  check('ANLEITUNG.txt: logo section after the figure steps, before the moods',
    sec > guideOff.indexOf('IN OBS EINBINDEN') && sec < guideOff.indexOf('STIMMUNGEN'), true);
  check('ANLEITUNG.txt: logo.html listed in the folder', guideOff.indexOf('logo.html      das Logo als eigene Quelle in OBS.') >= 0, true);
  check('ANLEITUNG.txt logo: Browser source named Logo, Local file, logo.html',
    after.indexOf('Wähle "Browser".') >= 0 && after.indexOf('Gib den Namen "Logo" ein.') >= 0 &&
    after.indexOf('"Lokale Datei" (Local file)') >= 0 && after.indexOf('Wähle logo.html aus diesem Ordner.') >= 0, true);
  check('ANLEITUNG.txt logo: real width and height', after.indexOf('6. Breite (Width): 800\r\n7. Höhe (Height): 520\r\n') >= 0, true);
  check('ANLEITUNG.txt logo: both checkboxes unticked',
    after.indexOf('(Shutdown source when not visible)') >= 0 && after.indexOf('(Refresh browser when scene becomes active)') >= 0, true);
  check('ANLEITUNG.txt logo: move, scale, Alt crop, above the figure',
    ['mit der Maus', 'roten Ecken', 'Halte Alt gedrückt', 'über der Figur'].every((k) => after.indexOf(k) >= 0), true);
  check('ANLEITUNG.txt logo: Image source alternative with the file', after.indexOf('"Bild" (Image)') >= 0 && after.indexOf('Datei logo.webp aus diesem Ordner') >= 0, true);
  check('ANLEITUNG.txt logo, inFigure false: says the logo is not in obs.html', after.indexOf('Das Logo ist nicht in obs.html.') >= 0, true);
  const guideOn = fileOf(filesOn, 'ANLEITUNG.txt');
  check('ANLEITUNG.txt logo, inFigure true: the extra source is optional',
    guideOn.indexOf('Das Logo steckt schon in obs.html.') >= 0 && guideOn.indexOf('brauchst du nur') >= 0, true);
  const guideNone = fileOf(filesNone, 'ANLEITUNG.txt');
  check('ANLEITUNG.txt without logo: no logo section, no logo.html', /DAS LOGO|logo\.html/.test(guideNone), false);

  /* Very wide and very tall logos: the suggested source keeps the full long
   * side and the box inside the insets keeps the logo's aspect. */
  [12, 3, 1, 0.5, 0.08].forEach((a) => {
    const s = IdleObsPackage.logoSourceSize(a);
    check('logoSourceSize ' + a + ': the long side is 800', Math.max(s.width, s.height), 800);
    checkClose('logoSourceSize ' + a + ': the inner box has the logo aspect', (s.width - 64) / (s.height - 64), a, a * 0.03);
  });
  const wide = fileOf(build(baseOpts({ logo: Object.assign({}, offLogo, { aspect: 12 }) })), 'ANLEITUNG.txt');
  check('ANLEITUNG.txt, logo aspect 12: 800 x 125', wide.indexOf('6. Breite (Width): 800\r\n7. Höhe (Height): 125\r\n') >= 0, true);
  const tall = fileOf(build(baseOpts({ logo: Object.assign({}, offLogo, { aspect: 0.08 }) })), 'ANLEITUNG.txt');
  check('ANLEITUNG.txt, logo aspect 0.08: 123 x 800', tall.indexOf('6. Breite (Width): 123\r\n7. Höhe (Height): 800\r\n') >= 0, true);
})();

if (failures) {
  console.error(failures + ' von ' + checks + ' Pruefungen fehlgeschlagen.');
  process.exit(1);
}

console.log(checks + ' Pruefungen, IdleObs.matchState, IdleFace und IdleObsPackage stimmen mit dem Vertrag ueberein.');
console.log('ADDONS-OK');
