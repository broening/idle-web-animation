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

if (failures) {
  console.error(failures + ' von ' + checks + ' Pruefungen fehlgeschlagen.');
  process.exit(1);
}

console.log(checks + ' Pruefungen, IdleObs.matchState stimmt mit dem Vertrag ueberein.');
console.log('ADDONS-OK');
