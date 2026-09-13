/*
 * Proves IdleObs.matchState behaves exactly like the contract in
 * gates/PLAN.md says: case-insensitive word match, first match in scene
 * order wins, a hyphenated word stays one token, and a word that is not a
 * state name never matches by accident.
 *
 * watchScene() and params() are browser-only (they touch window/DOM) and are
 * not exercised here - matchState is the pure part, and the only part that
 * needs to be right in Node as well as in OBS.
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

if (failures) {
  console.error(failures + ' von ' + checks + ' Pruefungen fehlgeschlagen.');
  process.exit(1);
}

console.log(checks + ' Pruefungen, IdleObs.matchState stimmt mit dem Vertrag ueberein.');
console.log('ADDONS-OK');
