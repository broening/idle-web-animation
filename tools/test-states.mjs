/*
 * Proves moods ("states") do what docs/figure-json.md says they do.
 *
 * A mood is the one input to solve() that authors write by hand in bulk, and
 * the engine answers a bad one by ignoring it, so a typo shows as nothing at
 * all. That is why checkStates() exists, and this test holds it to every
 * problem class the contract names. The rest pins down the behaviour a page
 * relies on: which mood a new blend starts from, where the picture swaps,
 * that tilt turns about the joint, that hidden wins over the eye roles, and
 * that a bad override falls back to the layer instead of turning into NaN.
 *
 * Beside moods sit the live face inputs, ctx.blink and ctx.mouth: a camera
 * page's blink has to beat the schedule and its anticipation, the mouth roles
 * switch at 0.5, and a mood's pictures and hidden keep working with both.
 *
 * Last, every figure on disk that has moods: no problems reported, and every
 * picture a mood swaps in exists. A missing file is a hole in the page that
 * only shows when that scene comes up on stream.
 *
 *   node tools/test-states.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);
const Idle = require(join(root, 'player', 'idle.js'));

function fail(msg) {
  console.error('FEHLER: ' + msg);
  process.exit(1);
}

let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) fail(msg);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const clone = (o) => JSON.parse(JSON.stringify(o));

/* A small rig with every kind of layer a mood can touch.
 *
 * The torso breathes at 4.7, not at the default 4.0, on purpose: a bad
 * override has to fall back to the layer's own value, and with the layer on
 * the default that is indistinguishable from falling back to the default. A
 * deliberately broken merge slipped through exactly that way. */
const base = () => ({
  size: { width: 1000, height: 1000 },
  motion: { stateSeconds: 0.5 },
  layers: [
    { id: 'torso', src: 'torso.webp', pivot: [0.5, 0.9], motions: [{ type: 'breathe', period: 4.7 }] },
    { id: 'kopf', src: 'kopf.webp', parent: 'torso', pivot: [0.5, 0.45], offset: [2, 0],
      motions: [{ type: 'gaze' }] },
    { id: 'mund', src: 'mund.webp', parent: 'kopf', pivot: [0.5, 0.5], crop: [400, 500, 100, 50] },
    { id: 'lid', src: 'lid.webp', parent: 'kopf', role: 'eyesClosed', pivot: [0.5, 0.5],
      motions: [{ type: 'blink' }] },
    { id: 'fx', parent: 'kopf', frames: ['1.webp', '2.webp'], pivot: [0.5, 0.5],
      motions: [{ type: 'flipbook', mode: 'burst', fps: 5, every: 6.5 }] },
    { id: 'geist', src: 'geist.webp', pivot: [0.5, 0.5], hidden: true }
  ]
});
const withStates = (states, patch) => Object.assign(base(), { states }, patch || {});
const idx = (fig, id) => fig.layers.findIndex(L => L.id === id);
const solveAt = (fig, t, state) => Idle.solve(fig, t, { pointerX: 0, pointerY: 0, state });

/* --- 1. checkStates: every problem class, and silence on a good figure --- */

const good = withStates({
  sad: {
    kopf: { offset: [2, 6], tilt: -2.5, gaze: { pixels: 5 } },
    torso: { breathe: { period: 5.5 } },
    mund: { src: 'mund-sad.webp', crop: [400, 510, 100, 60] },
    fx: { flipbook: { every: 3.1, mode: 'loop' } },
    geist: { hidden: false }
  },
  happy: { torso: { breathe: { period: 3.4, strength: 1.2 } }, kopf: { offset: [2, -3] } },
  'x-2_b': {}
});
{
  const before = JSON.stringify(good);
  const problems = Idle.checkStates(good);
  ok(same(problems, []), `checkStates meldet auf einer sauberen Figur: ${JSON.stringify(problems)}`);
  ok(JSON.stringify(good) === before, 'checkStates hat die Figur veraendert');
  ok(same(Idle.checkStates(base()), []), 'checkStates meldet etwas auf einer Figur ohne states');
}

const S = (ov) => withStates({ sad: ov });
const bad = [
  ['unbekannte Ebene', S({ ghost: { tilt: 1 } }), /there is no layer "ghost"/],
  ['Ebene "constructor" gibt es nicht', S({ constructor: { tilt: 1 } }), /no layer "constructor"/],
  ['fremder Schluessel', S({ kopf: { wobble: 1 } }), /kopf\.wobble is ignored.*nothing else/],
  ['Name mit Grossbuchstaben', withStates({ Sad: {} }), /Sad is ignored: a mood name/],
  ['Name mit Leerzeichen', withStates({ 'very sad': {} }), /a mood name/],
  ['Name beginnt mit -', withStates({ '-sad': {} }), /a mood name/],
  ['Name zu lang', withStates({ ['a'.repeat(33)]: {} }), /at most 32/],
  ['neutral definiert', withStates({ neutral: { kopf: { tilt: 1 } } }), /states\.neutral is ignored/],
  ['src auf frames-Ebene', S({ fx: { src: 'x.webp' } }), /fx\.src is ignored: the layer has frames/],
  ['Bewegung fehlt der Ebene', S({ kopf: { breathe: { period: 5 } } }), /no breathe motion.*does not add/],
  ['Bewegung ist kein Objekt', S({ torso: { breathe: 5.5 } }), /breathe has to be an object/],
  ['type in der Bewegung', S({ torso: { breathe: { type: 'sway' } } }), /breathe\.type is ignored/],
  ['Periode als Text', S({ torso: { breathe: { period: '5.5' } } }), /breathe\.period has to be a number/],
  ['mode unbekannt', S({ fx: { flipbook: { mode: 'sometimes' } } }), /mode has to be "loop" or "burst"/],
  ['tilt als Text', S({ kopf: { tilt: 'down' } }), /tilt has to be a number/],
  ['offset mit Text', S({ kopf: { offset: [0, '6'] } }), /offset has to be \[x, y\]/],
  ['offset zu kurz', S({ kopf: { offset: [6] } }), /offset has to be \[x, y\]/],
  ['hidden als Text', S({ geist: { hidden: 'yes' } }), /hidden has to be true or false/],
  ['src keine Zeichenkette', S({ mund: { src: 42 } }), /src has to be the path/],
  ['crop kaputt', S({ mund: { src: 'm.webp', crop: [1, 2, '3', 4] } }), /crop has to be \[x, y, width, height\]/],
  ['crop ohne src', S({ mund: { crop: [1, 2, 3, 4] } }), /crop is ignored: it belongs to a src/],
  ['states kein Objekt', withStates([]), /states has to be an object of moods/],
  ['states null', withStates(null), /states has to be an object of moods/],
  ['Stimmung kein Objekt', withStates({ sad: 3 }), /states\.sad has to be an object of layer ids/],
  ['Ueberschreibung kein Objekt', S({ kopf: 'up' }), /states\.sad\.kopf has to be an object/],
  ['stateSeconds negativ', withStates({}, { motion: { stateSeconds: -1 } }), /stateSeconds -1 .* 0\.4 is used/],
  ['stateSeconds zu gross', withStates({}, { motion: { stateSeconds: 9 } }), /stateSeconds 9 .* 5 is used/]
];
for (const key of ['id', 'pivot', 'parent', 'depth', 'role', 'blend', 'lag', 'frames', 'crops',
                   'motions', 'opacity', 'alt']) {
  bad.push([`Rig-Schluessel ${key}`, S({ kopf: { [key]: 1 } }),
            new RegExp('kopf\\.' + key + ' is ignored: ' + key + ' is part of the rig')]);
}
for (const [label, fig, pattern] of bad) {
  const problems = Idle.checkStates(fig);
  ok(problems.length === 1, `checkStates ${label}: erwartet genau eine Meldung, bekommen ${JSON.stringify(problems)}`);
  ok(pattern.test(problems[0] || ''), `checkStates ${label}: erwartet ${pattern}, bekommen ${JSON.stringify(problems)}`);
}
console.log(`checkStates: ${bad.length} kaputte Figuren je genau einmal gemeldet, die saubere nie.`);

/* --- 2. stateNames and stateSeconds -------------------------------------- */

ok(same(Idle.stateNames(withStates({ sad: {}, neutral: {}, Bad: {}, happy: {}, broken: 3 })),
        ['neutral', 'sad', 'happy']),
   `stateNames: ${JSON.stringify(Idle.stateNames(withStates({ sad: {}, neutral: {}, Bad: {}, happy: {}, broken: 3 })))}`);
ok(same(Idle.stateNames(base()), ['neutral']), 'stateNames ohne states muss ["neutral"] sein');
ok(same(Idle.stateNames(withStates([])), ['neutral']), 'stateNames mit states als Array muss ["neutral"] sein');
for (const [value, want] of [[undefined, 0.4], [0, 0], [1.5, 1.5], [-1, 0.4], ['slow', 0.4],
                             [Infinity, 0.4], [NaN, 0.4], [5, 5], [1e9, 5]]) {
  const fig = withStates({}, { motion: { stateSeconds: value } });
  ok(Idle.stateSeconds(fig) === want, `stateSeconds ${value}: erwartet ${want}, bekommen ${Idle.stateSeconds(fig)}`);
}

/* --- 3. what a mood does to solve() -------------------------------------- */

{
  const fig = good;
  const neutral = JSON.stringify(solveAt(fig, 7.3));
  for (const state of [undefined, 'neutral', 'furious', 'Sad', 'constructor', 'toString', '__proto__', 42, null,
                       { from: 'nope', to: 'nada', since: 1 }, { from: 'sad', to: 'sad', since: 7 }].slice(0, 10)) {
    ok(JSON.stringify(solveAt(fig, 7.3, state)) === neutral,
       `state ${JSON.stringify(state)} muss genau neutral zeigen`);
  }
  const sadAlone = JSON.stringify(solveAt(fig, 7.3, 'sad'));
  ok(sadAlone !== neutral, 'sad sieht aus wie neutral - die Pruefungen darunter pruefen nichts');
  ok(JSON.stringify(solveAt(fig, 7.3, { from: 'sad', to: 'sad', since: 7.1 })) === sadAlone,
     'eine Mischung von sad nach sad muss genau sad sein');
}

/* The rig is fixed: a mood that tries to move pivot, parent, depth, role or
 * blend changes nothing at all. */
{
  const fig = withStates({ sad: { kopf: { pivot: [0, 0], parent: 'geist', depth: 1, lag: 3, role: 'eyesOpen',
                                          blend: 'screen', opacity: 0, motions: [] } } });
  ok(JSON.stringify(solveAt(fig, 3.3, 'sad')) === JSON.stringify(solveAt(fig, 3.3)),
     'Rig-Schluessel in einer Stimmung haben die Figur veraendert');
}

/* tilt turns about the pivot, and children turn with it. */
{
  const fig = { size: { width: 1000, height: 1000 }, motion: {},
    layers: [{ id: 'arm', src: 'a', pivot: [0.3, 0.7], tilt: 90 },
             { id: 'hand', src: 'h', parent: 'arm', pivot: [0.8, 0.2] }] };
  const [arm, hand] = Idle.solve(fig, 0, {});
  const m = arm.matrix;
  ok(near(m[0], 0) && near(m[1], 1) && near(m[2], -1) && near(m[3], 0),
     `tilt 90 ergibt keine Vierteldrehung: ${JSON.stringify(m)}`);
  const px = m[0] * 300 + m[2] * 700 + m[4], py = m[1] * 300 + m[3] * 700 + m[5];
  ok(near(px, 300, 1e-6) && near(py, 700, 1e-6), `tilt dreht nicht um das Gelenk: (300,700) landet bei (${px},${py})`);
  ok(hand.matrix.every((v, j) => near(v, m[j], 1e-9)), 'das Kind erbt die Neigung nicht');

  const noTilt = clone(fig);
  noTilt.layers[0].tilt = 0;
  delete fig.layers[0].tilt;
  ok(JSON.stringify(Idle.solve(fig, 2, {})) === JSON.stringify(Idle.solve(noTilt, 2, {})),
     'tilt 0 und fehlendes tilt muessen gleich sein');

  const moodTilt = withStates({ sad: { kopf: { tilt: -2.5 } } });
  const k = idx(moodTilt, 'kopf');
  const a = solveAt(moodTilt, 0, 'sad')[k].matrix, b = solveAt(moodTilt, 0)[k].matrix;
  const angle = (mm) => Math.atan2(mm[1], mm[0]) * 180 / Math.PI;
  ok(near(angle(a) - angle(b), -2.5, 1e-6), `tilt einer Stimmung: ${angle(a) - angle(b)} Grad statt -2.5`);
}

/* hidden hides, a mood can show it again, and hidden: true beats the eye roles. */
{
  const fig = withStates({ sad: { geist: { hidden: false } }, closed: { lid: { hidden: true } } });
  const g = idx(fig, 'geist'), l = idx(fig, 'lid');
  ok(solveAt(fig, 1)[g].hidden === true, 'hidden: true versteckt die Ebene nicht');
  ok(solveAt(fig, 1, 'sad')[g].hidden === false, 'hidden: false in einer Stimmung zeigt die Ebene nicht wieder');

  let blinks = 0, leaked = 0;
  for (let i = 0; i < 3000; i++) {
    const t = i / 50;
    if (!solveAt(fig, t)[l].hidden) blinks++;          /* eyesClosed shows only mid-blink */
    if (!solveAt(fig, t, 'closed')[l].hidden) leaked++;
  }
  ok(blinks > 0, 'die Testfigur blinzelt in 60 s nie, die Rollenpruefung prueft nichts');
  ok(leaked === 0, `hidden: true verliert gegen die Rolle eyesClosed: ${leaked} Bilder sichtbar`);

  const calls = [];
  const gfx = { setTransform() {}, clearRect() {}, save() {}, restore() {},
                drawImage(img) { calls.push(img); } };
  const bank = {};
  for (const L of fig.layers) bank[L.id] = (L.frames || [L.src]).map(s => 'IMG:' + s);
  Idle.drawFrame(gfx, fig, bank, 1, {});
  ok(!calls.includes('IMG:geist.webp'), 'drawFrame zeichnet eine Ebene mit hidden: true');
  calls.length = 0;
  Idle.drawFrame(gfx, fig, bank, 1, { ctx: { state: 'sad' } });
  ok(calls.includes('IMG:geist.webp'), 'drawFrame zeichnet die Ebene nicht, die eine Stimmung wieder zeigt');
}

/* The picture swaps at the middle of the blend, with its own rectangle,
 * while position moves smoothly. stateSeconds 0.5, since 16: t = 16.25 is
 * w = 0.5 exactly in binary floating point. */
{
  const fig = good;
  const m = idx(fig, 'mund');
  const L = fig.layers[m];
  const blend = { from: 'neutral', to: 'sad', since: 16 };
  const early = solveAt(fig, 16.2499, blend)[m];
  const mid = solveAt(fig, 16.25, blend)[m];
  ok(early.src === 'mund.webp', `vor der Mitte zeigt der Mund ${early.src}`);
  ok(mid.src === 'mund-sad.webp', `in der Mitte zeigt der Mund ${mid.src}`);
  ok(same(Idle.imageOf(L, early, fig), { index: 0, src: 'mund.webp', crop: [400, 500, 100, 50] }),
     `imageOf vor der Mitte: ${JSON.stringify(Idle.imageOf(L, early, fig))}`);
  ok(same(Idle.imageOf(L, mid, fig), { index: 0, src: 'mund-sad.webp', crop: [400, 510, 100, 60] }),
     `imageOf in der Mitte: ${JSON.stringify(Idle.imageOf(L, mid, fig))}`);
  ok(same(Idle.imageOf(L, mid), { index: 0, src: 'mund-sad.webp', crop: null }),
     'imageOf ohne Figur kennt das Rechteck der Stimmung nicht und muss null geben');
  ok(same(Idle.imageOf(L, { frame: -2 }, fig).src, 'mund.webp'), 'imageOf ohne src im Zustand muss das eigene Bild zeigen');

  const k = idx(fig, 'kopf');
  const A = solveAt(fig, 16.25, 'neutral')[k].matrix;
  const B = solveAt(fig, 16.25, 'sad')[k].matrix;
  const M = solveAt(fig, 16.25, blend)[k].matrix;
  ok(M.every((v, j) => near(v, (A[j] + B[j]) / 2, 1e-9)), 'die Matrix in der Mitte ist nicht die Mitte der beiden Stimmungen');

  /* The frames layer: its src is always null, a mood's src on it is ignored. */
  const fxFig = withStates({ odd: { fx: { src: 'nie.webp' } } });
  const f = idx(fxFig, 'fx');
  ok(solveAt(fxFig, 3, 'odd')[f].src === null, 'eine frames-Ebene hat im Zustand ein src bekommen');
  ok(same(Idle.imagesOf(fxFig.layers[f], fxFig).map(p => p.src), ['1.webp', '2.webp']),
     'imagesOf listet ein src einer Stimmung auf einer frames-Ebene');
}

/* stateSeconds 0 is a hard cut, exactly at since. */
{
  const fig = withStates(good.states, { motion: { stateSeconds: 0 } });
  const m = idx(fig, 'mund');
  const blend = { from: 'neutral', to: 'sad', since: 20 };
  ok(JSON.stringify(solveAt(fig, 19.999999, blend)) === JSON.stringify(solveAt(fig, 19.999999, 'neutral')),
     'stateSeconds 0: vor since muss genau neutral stehen');
  ok(JSON.stringify(solveAt(fig, 20, blend)) === JSON.stringify(solveAt(fig, 20, 'sad')),
     'stateSeconds 0: ab since muss genau sad stehen');
  ok(solveAt(fig, 20, blend)[m].src === 'mund-sad.webp', 'stateSeconds 0: das Bild wechselt nicht bei since');
}

/* Edges of the blend input. */
{
  const fig = good;
  const at = (t, state) => JSON.stringify(solveAt(fig, t, state));
  ok(at(30, { from: 'neutral', to: 'sad', since: 31 }) === at(30, 'neutral'), 'since in der Zukunft muss from zeigen');
  ok(at(30, { from: 'neutral', to: 'sad' }) === at(30, 'sad'), 'fehlendes since muss to zeigen');
  ok(at(30, { from: 'neutral', to: 'sad', since: NaN }) === at(30, 'sad'), 'since NaN muss to zeigen');
  ok(at(30.1, { from: 'ghost', to: 'sad', since: 30 }) === at(30.1, { from: 'neutral', to: 'sad', since: 30 }),
     'ein unbekanntes from muss wie neutral mischen');
  ok(at(30.1, { from: 'sad', to: 'ghost', since: 30 }) === at(30.1, { from: 'sad', to: 'neutral', since: 30 }),
     'ein unbekanntes to muss wie neutral mischen');
  const huge = withStates(good.states, { motion: { stateSeconds: 1e9 } });
  const m = idx(huge, 'mund');
  ok(solveAt(huge, 42.5, { from: 'neutral', to: 'sad', since: 40 })[m].src === 'mund-sad.webp',
     'stateSeconds 1e9 wird nicht auf 5 begrenzt: bei 2.5 s ist der Wechsel nicht in der Mitte');
  const neg = withStates(good.states, { motion: { stateSeconds: -3 } });
  ok(solveAt(neg, 40.2, { from: 'neutral', to: 'sad', since: 40 })[m].src === 'mund-sad.webp' &&
     solveAt(neg, 40.19, { from: 'neutral', to: 'sad', since: 40 })[m].src === 'mund.webp',
     'stateSeconds -3 muss 0.4 werden');
  const final = solveAt(fig, 1e6, { from: 'neutral', to: 'sad', since: 0 });
  ok(final.every(s => s.matrix.every(Number.isFinite)), 'eine lange vergangene Mischung ergibt NaN');
}

/* Motion overrides: merged, never written back, never adding a motion,
 * and a bad value keeps the layer's own. */
{
  const t = 2.7;
  const T = (ov, layerMotions) => {
    const fig = withStates({ sad: { torso: ov } });
    if (layerMotions) fig.layers[0].motions = layerMotions;
    return fig;
  };
  const figSlow = T({ breathe: { period: 5.5 } });
  const before = JSON.stringify(figSlow.layers);
  const slow = solveAt(figSlow, t, 'sad')[0].matrix;
  ok(JSON.stringify(figSlow.layers) === before, 'eine Stimmung hat die Bewegung der Ebene veraendert');
  const direct = Idle.solve(Object.assign(base(), {}), t, {});
  const written = base();
  written.layers[0].motions[0].period = 5.5;
  ok(same(slow, Idle.solve(written, t, {})[0].matrix), 'period 5.5 als Stimmung ist nicht period 5.5 auf der Ebene');
  ok(!same(slow, direct[0].matrix), 'period 5.5 hat nichts bewirkt');

  const neutralTorso = solveAt(figSlow, t)[0].matrix;
  for (const [label, ov] of [
    ['period als Text', { breathe: { period: 'slow' } }],
    ['period NaN', { breathe: { period: NaN } }],
    ['type sway', { breathe: { type: 'sway' } }],
    ['fehlende Bewegung sway', { sway: { degrees: 30 } }],
    ['Bewegung als Zahl', { breathe: 3 }],
    ['Bewegung als Array', { breathe: [1] }]
  ]) {
    ok(same(solveAt(T(ov), t, 'sad')[0].matrix, neutralTorso), `${label}: die Stimmung haette nichts aendern duerfen`);
  }
  ok(same(solveAt(T({ breathe: { type: 'sway', period: 5.5 } }), t, 'sad')[0].matrix, slow),
     'type in der Ueberschreibung hat die uebrigen Werte verschluckt');

  const offBad = withStates({ sad: { kopf: { offset: ['a', 6] } } });
  const offGood = withStates({ sad: { kopf: { offset: [2, 6] } } });
  const k = idx(offBad, 'kopf');
  ok(same(solveAt(offBad, t, 'sad')[k].matrix, solveAt(offGood, t, 'sad')[k].matrix),
     'ein kaputter offset-Wert faellt nicht auf den der Ebene zurueck');
  const tiltBad = withStates({ sad: { kopf: { tilt: 'down' } } });
  ok(same(solveAt(tiltBad, t, 'sad'), solveAt(tiltBad, t)), 'ein kaputtes tilt hat die Figur veraendert');
}

/* Live edits, duplicate ids and moods naming missing layers. */
{
  const fig = withStates({ sad: { kopf: { tilt: -1 } } });
  const k = idx(fig, 'kopf');
  const one = solveAt(fig, 5, 'sad')[k].css;
  fig.states.sad.kopf.tilt = -4;
  ok(solveAt(fig, 5, 'sad')[k].css !== one, 'eine Aenderung an figure.states zeigt sich im naechsten Bild nicht');

  const dup = withStates({ sad: { d: { tilt: 10 } } });
  dup.layers.push({ id: 'd', src: 'd1', pivot: [0.5, 0.5] }, { id: 'd', src: 'd2', pivot: [0.5, 0.5] });
  const outDup = solveAt(dup, 1, 'sad');
  ok(outDup[dup.layers.length - 1].css === outDup[dup.layers.length - 2].css &&
     outDup[dup.layers.length - 1].css !== solveAt(dup, 1)[dup.layers.length - 1].css,
     'doppelte id: die Stimmung gilt nicht fuer beide Ebenen');

  const ghost = withStates({ sad: { ghost: { tilt: 3 }, kopf: { tilt: 3 } } });
  let st;
  try { st = solveAt(ghost, 1, 'sad'); } catch (e) { fail('eine Stimmung mit fehlender Ebene warf: ' + e.message); }
  ok(st.length === ghost.layers.length && st[idx(ghost, 'kopf')].css !== solveAt(ghost, 1)[idx(ghost, 'kopf')].css,
     'eine fehlende Ebene in der Stimmung verhindert die uebrigen Ueberschreibungen');

  const proto = withStates(JSON.parse('{"sad": {"__proto__": {"tilt": 5}}}'));
  proto.layers.push({ id: '__proto__', src: 'p', pivot: [0.5, 0.5] });
  const pIdx = proto.layers.length - 1;
  ok(solveAt(proto, 1, 'sad')[pIdx].css !== solveAt(proto, 1)[pIdx].css,
     'eine Ebene "__proto__" bekommt ihre Stimmung nicht (eigene Eigenschaft aus JSON)');
  const ctor = withStates({ sad: {} });
  ctor.layers.push({ id: 'constructor', src: 'c', pivot: [0.5, 0.5] });
  ok(solveAt(ctor, 1, 'sad')[ctor.layers.length - 1].css === solveAt(ctor, 1)[ctor.layers.length - 1].css,
     'eine Ebene "constructor" wurde aus Object.prototype ueberschrieben');
}
console.log('solve: tilt, hidden, Bildwechsel in der Mitte, harter Schnitt und schlechte Werte wie beschrieben.');

/* --- 4. setState on a real IdleFigure ------------------------------------ */

function fakeEl(tag) {
  return {
    tagName: tag.toUpperCase(), style: {}, children: [], className: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    set innerHTML(v) { this.children = []; },
    get innerHTML() { return ''; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  };
}
globalThis.document = { createElement: fakeEl };

{
  const fig = clone(good);
  const p = new Idle.IdleFigure(fakeEl('div'), fig, '', { background: false });
  ok(p.state === 'neutral' && p._stateMix === 'neutral', 'ein neuer Spieler steht nicht auf neutral');

  /* Playing, without a real clock: setState only reads `playing` and `time`. */
  p.playing = true;
  let renders = 0;
  const realRender = p.render;
  p.render = function (t) { renders++; return realRender.call(this, t); };

  ok(p.setState('furious') === false && p.state === 'neutral' && p._stateMix === 'neutral',
     'setState mit unbekanntem Namen muss false geben und nichts aendern');
  ok(p.setState('Sad') === false, 'setState mit ungueltigem Namen muss false geben');
  ok(p.setState('constructor') === false, 'setState("constructor") darf nicht aus Object.prototype kommen');
  ok(p.setState(undefined) === false, 'setState(undefined) muss false geben');

  p.time = 100;
  ok(p.setState('neutral') === true && p._stateMix === 'neutral', 'setState auf das aktuelle Ziel muss true geben und nichts aendern');
  ok(p.setState('sad') === true && p.state === 'sad', 'setState("sad") hat das Ziel nicht gesetzt');
  ok(same(p._stateMix, { from: 'neutral', to: 'sad', since: 100 }), `Mischung falsch: ${JSON.stringify(p._stateMix)}`);
  const running = p._stateMix;
  ok(p.setState('sad') === true && p._stateMix === running, 'setState auf das laufende Ziel hat die Mischung neu gestartet');

  /* A quarter in: neutral still shows more, so the next blend starts there. */
  p.time = 100.125;
  p.setState('happy');
  ok(same(p._stateMix, { from: 'neutral', to: 'happy', since: 100.125 }),
     `ein Viertel in der Mischung muss from neutral bleiben: ${JSON.stringify(p._stateMix)}`);
  /* Finished: the target is what shows. */
  p.time = 200;
  p.setState('sad');
  ok(same(p._stateMix, { from: 'happy', to: 'sad', since: 200 }), `nach der Mischung muss from happy sein: ${JSON.stringify(p._stateMix)}`);
  /* Three quarters in: the target shows more. */
  p.time = 200.375;
  p.setState('happy');
  ok(same(p._stateMix, { from: 'sad', to: 'happy', since: 200.375 }), `drei Viertel in der Mischung muss from sad sein: ${JSON.stringify(p._stateMix)}`);
  /* Exactly half: the picture has already swapped, so the target counts. */
  p.time = 200.625;
  p.setState('neutral');
  ok(same(p._stateMix, { from: 'happy', to: 'neutral', since: 200.625 }), `genau in der Mitte muss from happy sein: ${JSON.stringify(p._stateMix)}`);
  /* Back to where a young blend came from: no blend at all. */
  p.time = 200.7;
  p.setState('happy');
  ok(p._stateMix === 'happy' && p.state === 'happy', `zurueck zum from einer jungen Mischung muss hart sein: ${JSON.stringify(p._stateMix)}`);
  /* A since in the future (scrubbed back): the blend has not happened, from shows. */
  p.setState('sad');
  p.time = 150;
  p.setState('neutral');
  ok(same(p._stateMix, { from: 'happy', to: 'neutral', since: 150 }), `since in der Zukunft muss from happy nehmen: ${JSON.stringify(p._stateMix)}`);
  /* The mood it came from was deleted meanwhile. */
  p.time = 300;
  p.setState('happy');
  p.time = 300.1;
  delete fig.states.neutral;
  const keptHappy = fig.states.happy;
  p._stateMix = { from: 'gone', to: 'happy', since: 300 };
  p.setState('sad');
  ok(same(p._stateMix, { from: 'neutral', to: 'sad', since: 300.1 }), `ein geloeschtes from muss neutral werden: ${JSON.stringify(p._stateMix)}`);
  fig.states.happy = keptHappy;
  ok(renders === 0, `ein laufender Spieler hat bei setState ${renders} Mal selbst gezeichnet`);

  /* Window loop on: hard switch, and a running blend renders as its target. */
  p.loop = 16;
  p.setState('happy');
  ok(p._stateMix === 'happy', 'mit Fensterschleife darf keine Mischung starten');
  p._stateMix = { from: 'neutral', to: 'sad', since: 5 };
  p.render = realRender;
  const looped = p.render(5.1);
  ok(JSON.stringify(looped) === JSON.stringify(solveAt(fig, 5.1, 'sad')), 'render mit Fensterschleife zeigt nicht das Ziel der Mischung');
  p.loop = 0;
  p._stateMix = 'happy';
  p.state = 'happy';

  /* stateSeconds 0: hard switch. */
  fig.motion.stateSeconds = 0;
  p.setState('sad');
  ok(p._stateMix === 'sad', 'stateSeconds 0 darf keine Mischung starten');
  fig.motion.stateSeconds = 0.5;

  /* Paused: hard switch, and the page shows the new mood right away. */
  p.playing = false;
  let paused = 0;
  p.render = function (t) { paused++; return realRender.call(this, t); };
  p.time = 400;
  ok(p.setState('neutral') === true && p._stateMix === 'neutral', 'ein pausierter Spieler darf keine Mischung starten');
  p.setState('sad');
  ok(paused === 2, `ein pausierter Spieler muss bei jedem Wechsel neu zeichnen, zeichnete ${paused} Mal`);
  const mundNode = p._nodes.mund;
  const shown = mundNode.imgs.filter(im => im.style.visibility !== 'hidden').map(im => im.src);
  ok(same(shown, ['mund-sad.webp']), `pausiert nach setState("sad") zeigt die Seite ${JSON.stringify(shown)}`);
  p.setState('neutral');
  const back = mundNode.imgs.filter(im => im.style.visibility !== 'hidden').map(im => im.src);
  ok(same(back, ['mund.webp']), `zurueck auf neutral zeigt die Seite ${JSON.stringify(back)}`);
  ok(p.setState('nope') === false && paused === 3, 'ein abgelehnter Name darf nicht neu zeichnen');
}
console.log('setState: unbekannt false, gleich unveraendert, from ist die Seite, die mehr zeigt.');

/* --- 4b. live face input: ctx.blink and ctx.mouth ------------------------
 *
 * A camera page hands solve() how far the lids are down and how far the
 * mouth is open. ctx.blink replaces the schedule of every blink motion, so it
 * has to win inside a scheduled blink, in the widening before one, and when
 * the blink motion sits on the head instead of the eyes. ctx.mouth drives the
 * two mouth roles at one threshold. Both sit beside moods, so a mood's
 * pictures and a mood's hidden have to keep working with them. */

const face = () => ({
  size: { width: 1000, height: 1000 },
  motion: { stateSeconds: 0.5 },
  layers: [
    { id: 'kopf', src: 'kopf.webp', pivot: [0.5, 0.6], motions: [{ type: 'gaze' }] },
    { id: 'auf', src: 'auf.webp', parent: 'kopf', role: 'eyesOpen', pivot: [0.5, 0.4],
      motions: [{ type: 'blink' }] },
    { id: 'zu', src: 'zu.webp', parent: 'kopf', role: 'eyesClosed', pivot: [0.5, 0.4],
      motions: [{ type: 'blink' }] },
    { id: 'mund-auf', src: 'mund-auf.webp', parent: 'kopf', role: 'mouthOpen', pivot: [0.5, 0.7] },
    { id: 'mund-zu', src: 'mund-zu.webp', parent: 'kopf', role: 'mouthClosed', pivot: [0.5, 0.7] }
  ]
});
const byIdOf = (st) => Object.fromEntries(st.map(s => [s.id, s]));
const faceAt = (fig, t, ctx) => byIdOf(Idle.solve(fig, t, ctx));
const withoutBlink = (fig) => {
  const f = clone(fig);
  for (const L of f.layers) if (L.motions) L.motions = L.motions.filter(m => m.type !== 'blink');
  return f;
};
/* Dense enough to land inside a 0.13 s blink and inside the 0.14 s widening
 * before one: 60 s at 100 samples a second. */
const DENSE = Array.from({ length: 6000 }, (_, i) => i / 100);
const SPARSE = DENSE.filter((_, i) => i % 37 === 0);

/* Where the schedule blinks, and where it widens without blinking yet, on a
 * figure whose blink sits on `id`. Both lists must be non-empty, or every
 * check below that uses them proves nothing. */
function scheduleOf(fig, id, roleId) {
  const bare = withoutBlink(fig);
  const blinks = [], widens = [];
  for (const t of DENSE) {
    const s = faceAt(fig, t, {});
    if (s[roleId].hidden) blinks.push(t);
    else if (!same(s[id].matrix, faceAt(bare, t, {})[id].matrix)) widens.push(t);
  }
  ok(blinks.length > 0, `die Testfigur (blink auf ${id}) blinzelt in 60 s nie`);
  ok(widens.length > 0, `die Testfigur (blink auf ${id}) weitet das Auge in 60 s nie vorab`);
  return { bare, blinks, widens };
}

/* ctx.blink on the eye layers themselves. */
{
  const fig = face();
  const { bare, blinks, widens } = scheduleOf(fig, 'auf', 'auf');

  for (const t of SPARSE.concat(blinks, widens)) {
    const s = faceAt(fig, t, { blink: 1 });
    ok(s.auf.hidden === true && s.zu.hidden === false,
       `ctx.blink 1 bei t=${t}: eyesOpen hidden=${s.auf.hidden}, eyesClosed hidden=${s.zu.hidden}`);
    ok(s.auf.blink === 1 && s.zu.blink === 1, `ctx.blink 1 bei t=${t}: blink ist ${s.auf.blink}`);
  }
  for (const t of blinks) {
    const s = faceAt(fig, t, { blink: 0 });
    ok(s.auf.hidden === false && s.zu.hidden === true,
       `ctx.blink 0 mitten im geplanten Blinzeln bei t=${t}: die Augen gehen trotzdem zu`);
  }
  /* No widening while the input is set: the eye layers sit exactly where
   * they would with no blink motion at all, before, during and between. */
  for (const t of widens.concat(blinks, SPARSE)) {
    for (const v of [0, 0.3, 1]) {
      const s = faceAt(fig, t, { blink: v }), b = faceAt(bare, t, {});
      ok(same(s.auf.matrix, b.auf.matrix) && same(s.zu.matrix, b.zu.matrix),
         `ctx.blink ${v} bei t=${t}: das Auge weitet sich trotzdem (sy ${s.auf.matrix[3]} statt ${b.auf.matrix[3]})`);
    }
  }
  /* Undefined, and anything that is not a finite number, is the schedule to
   * the bit - a tracker that loses the face hands back to the figure. */
  const probe = [blinks[0], widens[0], 0, 7.77].concat(SPARSE.slice(0, 20));
  for (const t of probe) {
    const plain = JSON.stringify(Idle.solve(fig, t, {}));
    for (const v of [undefined, null, NaN, Infinity, -Infinity, '1', '0', true, [1], {}]) {
      ok(JSON.stringify(Idle.solve(fig, t, { blink: v })) === plain,
         `ctx.blink ${String(v)} bei t=${t} muss genau den Zeitplan zeigen`);
    }
  }
  /* Clamped, and 0.5 is still open, like the schedule's own threshold. */
  const t0 = widens[0];
  ok(JSON.stringify(Idle.solve(fig, t0, { blink: 7 })) === JSON.stringify(Idle.solve(fig, t0, { blink: 1 })),
     'ctx.blink 7 muss wie 1 sein');
  ok(JSON.stringify(Idle.solve(fig, t0, { blink: -3 })) === JSON.stringify(Idle.solve(fig, t0, { blink: 0 })),
     'ctx.blink -3 muss wie 0 sein');
  ok(faceAt(fig, t0, { blink: 0.5 }).auf.hidden === false, 'ctx.blink 0.5 muss die Augen offen lassen');
  ok(faceAt(fig, t0, { blink: 0.5000001 }).auf.hidden === true, 'ctx.blink knapp ueber 0.5 muss die Augen schliessen');

  const c = { blink: 7, mouth: -1 };
  Idle.solve(fig, 1, c);
  ok(same(c, { blink: 7, mouth: -1 }), 'solve hat ctx veraendert');
}

/* ctx.blink with the blink motion on the head only. The roles find it
 * through the parent, and the head's own widening - the one that lifts a
 * hat - stops too. */
{
  const fig = face();
  fig.layers[0].motions.push({ type: 'blink' });
  delete fig.layers[1].motions;
  delete fig.layers[2].motions;
  const { bare, blinks, widens } = scheduleOf(fig, 'kopf', 'auf');
  for (const t of SPARSE.concat(blinks)) {
    const s = faceAt(fig, t, { blink: 1 });
    ok(s.auf.hidden === true && s.zu.hidden === false, `blink am Kopf, ctx.blink 1 bei t=${t}: Augen nicht zu`);
  }
  for (const t of blinks) {
    const s = faceAt(fig, t, { blink: 0 });
    ok(s.auf.hidden === false && s.zu.hidden === true, `blink am Kopf, ctx.blink 0 bei t=${t}: Augen gehen zu`);
  }
  for (const t of widens) {
    const s = faceAt(fig, t, { blink: 0 }), b = faceAt(bare, t, {});
    ok(same(s.kopf.matrix, b.kopf.matrix) && same(s.auf.matrix, b.auf.matrix),
       `blink am Kopf, ctx.blink 0 bei t=${t}: der Kopf weitet sich trotzdem`);
  }
}

/* A figure with no blink motion anywhere does not blink from the camera
 * either: ctx.blink drives blink motions, and the roles read those. */
{
  const fig = withoutBlink(face());
  const s = faceAt(fig, 3, { blink: 1 });
  ok(s.auf.hidden === false && s.zu.hidden === true, 'ohne blink-Bewegung darf ctx.blink die Augen nicht schliessen');
}

/* ctx.mouth: one threshold, closed when not given, nothing else touched. */
{
  const fig = face();
  const { blinks } = scheduleOf(fig, 'auf', 'auf');
  for (const [v, open] of [[undefined, false], [0, false], [0.3, false], [0.5, false], [0.5000001, true],
                           [0.8, true], [1, true], [7, true], [-2, false], [NaN, false], [Infinity, false],
                           ['1', false], [null, false], [true, false]]) {
    for (const t of [0, 2.5, blinks[0]]) {
      const s = faceAt(fig, t, v === undefined ? {} : { mouth: v });
      ok(s['mund-auf'].hidden === !open && s['mund-zu'].hidden === open,
         `ctx.mouth ${String(v)} bei t=${t}: mouthOpen hidden=${s['mund-auf'].hidden}, mouthClosed hidden=${s['mund-zu'].hidden}`);
    }
  }
  /* The mouth only hides and shows. Every matrix, and every layer without a
   * mouth role, is the same at 0 and at 1. */
  for (const t of SPARSE) {
    const a = Idle.solve(fig, t, { mouth: 0 }), b = Idle.solve(fig, t, { mouth: 1 });
    ok(a.every((s, i) => s.css === b[i].css && s.opacity === b[i].opacity &&
                         (/^mouth/.test(s.role || '') || s.hidden === b[i].hidden)),
       `ctx.mouth bei t=${t} hat mehr veraendert als die Mundrollen`);
  }
  /* Eyes and mouth are independent: a scheduled blink with the mouth open,
   * a live blink with the mouth closed. */
  const mid = faceAt(fig, blinks[0], { mouth: 1 });
  ok(mid.auf.hidden === true && mid['mund-auf'].hidden === false, 'ctx.mouth stoert das geplante Blinzeln');
  const shut = faceAt(fig, 2.5, { blink: 1 });
  ok(shut['mund-zu'].hidden === false && shut['mund-auf'].hidden === true, 'ctx.blink bewegt den Mund');

  /* A mouth layer that also carries a blink motion is still a mouth: the
   * blink sets its blink level, and only the eye roles read that. */
  const both = face();
  both.layers[3].motions = [{ type: 'blink' }];
  both.layers[4].motions = [{ type: 'blink' }];
  for (const t of [blinks[0], 2.5]) {
    const s = faceAt(both, t, { blink: 1, mouth: 1 });
    ok(s['mund-auf'].hidden === false && s['mund-zu'].hidden === true,
       `Mundebene mit blink-Bewegung bei t=${t}: das Blinzeln versteckt den offenen Mund`);
    const q = faceAt(both, t, {});
    ok(q['mund-auf'].hidden === true && q['mund-zu'].hidden === false,
       `Mundebene mit blink-Bewegung bei t=${t}: das Blinzeln zeigt den offenen Mund`);
  }
}

/* hidden beats the mouth roles, from the layer and from a mood; a mood that
 * swaps only the closed mouth keeps neutral's open one; a blend switches
 * the roles with the rest of the discrete state. */
{
  const fig = face();
  fig.layers[4].hidden = true;
  fig.states = {
    grin: { 'mund-zu': { src: 'mund-zu-grin.webp' } },
    stumm: { 'mund-auf': { hidden: true } },
    offen: { 'mund-zu': { hidden: false } }
  };
  ok(same(Idle.checkStates(fig), []), `checkStates meldet auf der Gesichtsfigur: ${JSON.stringify(Idle.checkStates(fig))}`);

  ok(faceAt(fig, 1, { mouth: 0 })['mund-zu'].hidden === true, 'hidden: true verliert gegen die Rolle mouthClosed');
  ok(faceAt(fig, 1, { mouth: 1, state: 'stumm' })['mund-auf'].hidden === true,
     'hidden: true einer Stimmung verliert gegen die Rolle mouthOpen');
  ok(faceAt(fig, 1, { mouth: 1, state: 'offen' })['mund-zu'].hidden === true,
     'hidden: false einer Stimmung muss die Rolle mouthClosed trotzdem gelten lassen');
  ok(faceAt(fig, 1, { mouth: 0, state: 'offen' })['mund-zu'].hidden === false,
     'hidden: false einer Stimmung zeigt den geschlossenen Mund nicht wieder');

  const g = clone(fig);
  delete g.layers[4].hidden;
  const open = faceAt(g, 1, { mouth: 1, state: 'grin' });
  const closed = faceAt(g, 1, { mouth: 0, state: 'grin' });
  ok(open['mund-auf'].hidden === false && open['mund-auf'].src === 'mund-auf.webp' && open['mund-zu'].hidden === true,
     `grin mit offenem Mund muss den offenen Mund von neutral zeigen: ${JSON.stringify(open['mund-auf'])}`);
  ok(same(Idle.imageOf(g.layers[3], open['mund-auf'], g).src, 'mund-auf.webp'),
     'imageOf zeigt unter grin nicht den offenen Mund von neutral');
  ok(closed['mund-zu'].hidden === false && closed['mund-zu'].src === 'mund-zu-grin.webp',
     `grin mit geschlossenem Mund muss mund-zu-grin zeigen: ${JSON.stringify(closed['mund-zu'])}`);

  /* stateSeconds 0.5, since 10: 10.1 is a fifth in, 10.4 four fifths. */
  for (const [t, side] of [[10.1, 'neutral'], [10.4, 'stumm']]) {
    for (const input of [{ mouth: 1 }, { mouth: 0 }, { mouth: 1, blink: 1 }, { blink: 0 }]) {
      const blend = byIdOf(Idle.solve(g, t, Object.assign({ state: { from: 'neutral', to: 'stumm', since: 10 } }, input)));
      const plain = byIdOf(Idle.solve(g, t, Object.assign({ state: side }, input)));
      for (const id of ['auf', 'zu', 'mund-auf', 'mund-zu']) {
        ok(blend[id].hidden === plain[id].hidden,
           `Mischung bei t=${t} mit ${JSON.stringify(input)}: ${id} hidden=${blend[id].hidden}, ${side} allein ${plain[id].hidden}`);
      }
    }
  }
}

/* Both renderers and the player: drawFrame reads the mouth and blink from
 * opts.ctx, IdleFigure passes its fields into ctx and leaves them undefined
 * until a page sets them. */
{
  const fig = face();
  const { blinks } = scheduleOf(fig, 'auf', 'auf');
  const calls = [];
  const gfx = { setTransform() {}, clearRect() {}, save() {}, restore() {},
                drawImage(img) { calls.push(img); } };
  const bank = {};
  for (const L of fig.layers) bank[L.id] = [L.src].map(s => 'IMG:' + s);
  const drawn = (ctx) => { calls.length = 0; Idle.drawFrame(gfx, fig, bank, 2.5, { ctx }); return calls.slice(); };
  let d = drawn({});
  ok(d.includes('IMG:mund-zu.webp') && !d.includes('IMG:mund-auf.webp'), `drawFrame ohne mouth: ${d}`);
  d = drawn({ mouth: 1 });
  ok(d.includes('IMG:mund-auf.webp') && !d.includes('IMG:mund-zu.webp'), `drawFrame mit mouth 1: ${d}`);
  d = drawn({ blink: 1 });
  ok(d.includes('IMG:zu.webp') && !d.includes('IMG:auf.webp'), `drawFrame mit blink 1: ${d}`);

  const p = new Idle.IdleFigure(fakeEl('div'), fig, '', { background: false });
  ok(p.blink === undefined && p.mouth === undefined, 'ein neuer Spieler hat blink oder mouth schon gesetzt');
  const t = blinks[0];
  ok(JSON.stringify(p.render(t)) === JSON.stringify(Idle.solve(fig, t, { pointerX: 0, pointerY: 0, state: 'neutral' })),
     'render ohne blink und mouth zeigt nicht den Zeitplan');
  p.blink = 0;
  p.mouth = 1;
  ok(JSON.stringify(p.render(t)) === JSON.stringify(Idle.solve(fig, t, { blink: 0, mouth: 1 })),
     'render gibt blink und mouth nicht an solve weiter');
  const vis = (id) => p._nodes[id].box.style.opacity > 0.001;
  ok(vis('auf') && !vis('zu') && vis('mund-auf') && !vis('mund-zu'),
     `render mit blink 0, mouth 1 zeigt auf=${vis('auf')} zu=${vis('zu')} mund-auf=${vis('mund-auf')} mund-zu=${vis('mund-zu')}`);
  p.blink = 1;
  p.mouth = undefined;
  p.render(2.5);
  ok(!vis('auf') && vis('zu') && !vis('mund-auf') && vis('mund-zu'), 'render mit blink 1, mouth undefined stimmt nicht');
}
console.log('Gesicht: ctx.blink ersetzt den Zeitplan samt Vorweiten, auch am Kopf; ctx.mouth schaltet bei 0.5; hidden gewinnt.');

/* --- 5. every figure on disk with moods ---------------------------------- */

const figuresDir = join(root, 'figures');
let withMoods = 0, pictures = 0;
if (existsSync(figuresDir)) {
  for (const name of readdirSync(figuresDir)) {
    const file = join(figuresDir, name, 'figure.json');
    if (!existsSync(file)) continue;
    const fig = JSON.parse(readFileSync(file, 'utf8'));
    if (fig.states === undefined) continue;
    withMoods++;
    const problems = Idle.checkStates(fig);
    if (problems.length) fail(`${name}: ${problems.length} Problem(e) in states:\n  ` + problems.join('\n  '));
    for (const L of fig.layers || []) {
      const pics = Idle.imagesOf(L, fig);
      const own = (L.frames && L.frames.length) ? L.frames.length : 1;
      for (const pic of pics.slice(own)) {
        pictures++;
        if (!existsSync(join(figuresDir, name, pic.src))) {
          fail(`${name}: Ebene ${L.id} zeigt in einer Stimmung ${pic.src}, die Datei fehlt`);
        }
        checks++;
      }
    }
    checks++;
  }
}
console.log(withMoods
  ? `Figuren: ${withMoods} mit Stimmungen, ${pictures} Stimmungsbilder, alle vorhanden, keine Meldung.`
  : 'Figuren: noch keine Figur mit Stimmungen auf der Platte, die Pruefung laeuft, sobald eine kommt.');

console.log(`${checks} Pruefungen.`);
console.log('ZUSTAENDE-OK');
