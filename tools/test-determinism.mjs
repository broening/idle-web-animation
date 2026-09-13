/*
 * Proves the engine is a pure function of time.
 *
 * This is the gate behind every other check in the project. If solve() ever
 * returned something different for the same t, the timeline scrubber would
 * lie, the contact sheet would show frames that never happen during playback,
 * and the IoU numbers would drift between runs. So it gets tested first.
 *
 *   node tools/test-determinism.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
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

/* A figure that exercises all six building blocks, so no motion type can
 * quietly become non-deterministic without this catching it. */
const synthetic = {
  name: 'synthetic',
  size: { width: 1000, height: 1000 },
  motion: { windowSeconds: 8, followSeconds: 0.085, parallax: 0.4 },
  layers: [
    { id: 'a', src: 'a.webp', pivot: [0.5, 0.9], depth: 0.2,
      motions: [{ type: 'breathe', strength: 1 }] },
    { id: 'b', src: 'b.webp', parent: 'a', pivot: [0.3, 0.6], depth: 0.5,
      motions: [{ type: 'sway', strength: 1.2, period: 7.5 }] },
    { id: 'c', src: 'c.webp', parent: 'b', pivot: [0.5, 0.5], depth: 0.6,
      motions: [{ type: 'gaze', strength: 1 }, { type: 'glow', strength: 0.7 }] },
    { id: 'd', src: 'd.webp', parent: 'c', role: 'eyesOpen', pivot: [0.5, 0.5],
      motions: [{ type: 'blink' }] },
    { id: 'e', parent: 'c', pivot: [0.5, 0.4], depth: 0.8,
      frames: ['1.webp', '2.webp', '3.webp', '4.webp'],
      motions: [{ type: 'flipbook', mode: 'burst', fps: 5, every: 6.5 }] },
    { id: 'f', parent: 'a', pivot: [0.2, 0.7],
      frames: ['x.webp', 'y.webp'],
      motions: [{ type: 'flipbook', mode: 'loop', fps: 9 }] }
  ]
};

const figures = [['synthetic', synthetic]];

const priestPath = join(root, 'figures', 'priest', 'figure.json');
if (existsSync(priestPath)) {
  figures.push(['priest', JSON.parse(readFileSync(priestPath, 'utf8'))]);
}

/* Times chosen to land on and around the awkward places: zero, a blink, a
 * burst boundary, deep negatives from the follow-through lag, and a long way
 * out where floating point has had time to drift. */
const TIMES = [0, 0.0001, 0.083, 1, 3.999, 4, 4.0001, 6.5, 7.999, 8,
               13.37, 60, 599.5, 3600.25];
const POINTERS = [
  { pointerX: 0, pointerY: 0 },
  { pointerX: -1, pointerY: 1 },
  { pointerX: 0.37, pointerY: -0.62 }
];

let checks = 0;

for (const [label, fig] of figures) {
  for (const t of TIMES) {
    for (const ptr of POINTERS) {
      const a = JSON.stringify(Idle.solve(fig, t, ptr));

      /* Interleave unrelated work so any hidden state would show up. */
      Idle.solve(fig, t + 1.234, { pointerX: 0.9, pointerY: -0.4 });
      Idle.solve(fig, t * 3 + 7, { pointerX: -0.2, pointerY: 0.8 });

      const b = JSON.stringify(Idle.solve(fig, t, ptr));
      if (a !== b) fail(`${label} bei t=${t} pointer=${JSON.stringify(ptr)} nicht stabil`);

      const parsed = JSON.parse(a);
      if (parsed.length !== (fig.layers || []).length) {
        fail(`${label} bei t=${t}: ${parsed.length} Zustaende fuer ${fig.layers.length} Ebenen`);
      }
      for (const s of parsed) {
        for (const v of s.matrix) {
          if (!Number.isFinite(v)) fail(`${label} bei t=${t}: Ebene ${s.id} hat NaN in der Matrix`);
        }
        if (!Number.isFinite(s.opacity)) fail(`${label} bei t=${t}: Ebene ${s.id} hat NaN als Deckkraft`);
      }
      checks++;
    }
  }
}

/* Movement must actually happen - a frozen engine would pass every test
 * above. Compare the whole window against t=0 and demand real change. */
for (const [label, fig] of figures) {
  const base = JSON.stringify(Idle.solve(fig, 0, { pointerX: 0, pointerY: 0 }));
  let moved = 0;
  for (let t = 0.25; t <= 8; t += 0.25) {
    if (JSON.stringify(Idle.solve(fig, t, { pointerX: 0, pointerY: 0 })) !== base) moved++;
  }
  if (moved < 24) fail(`${label} bewegt sich kaum: nur ${moved} von 32 Zeitpunkten weichen ab`);
}

/* --- moods --------------------------------------------------------------
 *
 * A mood arrives through ctx.state, and a blend between two moods is a
 * function of t like everything else: { from, to, since } plus t gives one
 * answer. So the same checks apply - repeated solves identical, with
 * unrelated work in between - plus one that only a blend can fail: it must
 * not jump. */

const moody = {
  name: 'moody',
  size: { width: 1000, height: 1000 },
  motion: { followSeconds: 0.085, parallax: 0.4, stateSeconds: 0.4 },
  layers: [
    { id: 'torso', src: 'torso.webp', pivot: [0.5, 0.9], depth: 0.2,
      motions: [{ type: 'breathe', period: 4.0 }] },
    { id: 'kopf', src: 'kopf.webp', parent: 'torso', pivot: [0.5, 0.45], depth: 0.45,
      motions: [{ type: 'gaze' }] },
    { id: 'mund', src: 'mund.webp', parent: 'kopf', pivot: [0.5, 0.5] },
    { id: 'lid', src: 'lid.webp', parent: 'kopf', role: 'eyesClosed', pivot: [0.5, 0.5],
      motions: [{ type: 'blink' }] },
    { id: 'fx', parent: 'kopf', frames: ['1.webp', '2.webp'], pivot: [0.5, 0.5],
      motions: [{ type: 'flipbook', mode: 'burst', fps: 5, every: 6.5 }] }
  ],
  states: {
    sad: { torso: { breathe: { period: 5.5 } }, kopf: { offset: [0, 6], tilt: -2.5 },
           mund: { src: 'mund-sad.webp' }, fx: { flipbook: { every: 3.1 } } },
    happy: { torso: { breathe: { period: 3.4, strength: 1.2 } }, kopf: { offset: [0, -3] } }
  }
};

const STATE_INPUTS = [
  undefined, 'neutral', 'sad', 'happy', 'nosuchmood',
  { from: 'neutral', to: 'sad', since: 3.9 },
  { from: 'sad', to: 'happy', since: 599.3 },
  { from: 'happy', to: 'neutral', since: 13.2 }
];

let stateChecks = 0;
for (const t of TIMES) {
  for (const state of STATE_INPUTS) {
    for (const ptr of POINTERS) {
      const ctx = Object.assign({}, ptr, { state });
      const a = JSON.stringify(Idle.solve(moody, t, ctx));
      Idle.solve(moody, t + 0.2, { pointerX: 0.1, pointerY: 0.2, state: 'happy' });
      Idle.solve(moody, t * 2 + 1, { state: { from: 'sad', to: 'neutral', since: t } });
      const b = JSON.stringify(Idle.solve(moody, t, ctx));
      if (a !== b) fail(`moody mit state=${JSON.stringify(state)} bei t=${t} nicht stabil`);
      for (const s of JSON.parse(a)) {
        if (!s.matrix.every(Number.isFinite) || !Number.isFinite(s.opacity)) {
          fail(`moody mit state=${JSON.stringify(state)} bei t=${t}: Ebene ${s.id} hat NaN`);
        }
      }
      stateChecks++;
    }
  }
}

/* Mid-blend, sampled densely: every one of these lands strictly inside a
 * blend, where both moods are solved and mixed. */
for (let i = 1; i < 40; i++) {
  const since = 1000.1;
  const t = since + i * 0.01;
  const ctx = { pointerX: 0.3, pointerY: -0.2, state: { from: 'neutral', to: 'sad', since } };
  const a = JSON.stringify(Idle.solve(moody, t, ctx));
  Idle.solve(moody, t, { state: 'sad' });
  if (a !== JSON.stringify(Idle.solve(moody, t, ctx))) fail(`Mischung bei t=${t} nicht stabil`);
  stateChecks++;
}

/* The mood a blend comes from and the one it goes to are shown exactly,
 * to the bit, outside the blend - the mix is not a third look. */
{
  const since = 1000.1;
  const blend = { from: 'neutral', to: 'sad', since };
  const before = JSON.stringify(Idle.solve(moody, since - 0.05, { state: blend }));
  const after = JSON.stringify(Idle.solve(moody, since + 0.45, { state: blend }));
  if (before !== JSON.stringify(Idle.solve(moody, since - 0.05, { state: 'neutral' }))) {
    fail('vor dem Wechsel zeigt die Mischung nicht genau neutral');
  }
  if (after !== JSON.stringify(Idle.solve(moody, since + 0.45, { state: 'sad' }))) {
    fail('nach dem Wechsel zeigt die Mischung nicht genau sad');
  }
  stateChecks += 2;
}

/* No jump. A torso breathing at 4.0 s is asked to breathe at 5.5 s at
 * t = 1000.1, where the two sines are nowhere near each other in phase.
 * Re-timing one sine would teleport the chest; mixing two running ones must
 * not.
 *
 * The bound is not a guess. Between two samples h apart the mix
 * m = A + w (B - A) changes by
 *     (1 - w1)(A1 - A0) + w1 (B1 - B0) + (w1 - w0)(B0 - A0),
 * so no step can exceed M + (h / stateSeconds) * D, where M is the largest
 * step either mood takes on its own - plain breathing speed - and D is the
 * largest distance between the two. Both are measured on the same samples,
 * component by component of the matrix. A hard switch instead steps by up to
 * D in one frame, which is what the second half checks the bound would catch. */
function stepsOf(fig, ctxAt, t0, t1, h) {
  const out = [];
  for (let t = t0, i = 0; t <= t1 + 1e-9; i++, t = t0 + i * h) out.push(Idle.solve(fig, t, ctxAt(t)));
  return out;
}
function maxStep(frames) {
  let m = 0, at = -1;
  for (let i = 1; i < frames.length; i++) {
    for (let L = 0; L < frames[i].length; L++) {
      for (let j = 0; j < 6; j++) {
        const d = Math.abs(frames[i][L].matrix[j] - frames[i - 1][L].matrix[j]);
        if (d > m) { m = d; at = i; }
      }
    }
  }
  return { m, at };
}
function maxDistance(fa, fb) {
  let m = 0;
  for (let i = 0; i < fa.length; i++) {
    for (let L = 0; L < fa[i].length; L++) {
      for (let j = 0; j < 6; j++) m = Math.max(m, Math.abs(fa[i][L].matrix[j] - fb[i][L].matrix[j]));
    }
  }
  return m;
}

for (const [label, fig, to] of [
  ['lungs', {
    size: { width: 1000, height: 1000 }, motion: { stateSeconds: 0.4 },
    layers: [{ id: 'torso', src: 't.webp', pivot: [0.5, 0.9], motions: [{ type: 'breathe', period: 4.0 }] }],
    states: { slow: { torso: { breathe: { period: 5.5 } } } }
  }, 'slow'],
  ['moody', moody, 'sad']
]) {
  const h = 1 / 120;
  const since = 1000.1;
  const ss = Idle.stateSeconds(fig);
  const t0 = since - 0.2, t1 = since + ss + 0.2;
  const blend = stepsOf(fig, () => ({ state: { from: 'neutral', to, since } }), t0, t1, h);
  const sideA = stepsOf(fig, () => ({ state: 'neutral' }), t0, t1, h);
  const sideB = stepsOf(fig, () => ({ state: to }), t0, t1, h);
  const M = Math.max(maxStep(sideA).m, maxStep(sideB).m);
  const D = maxDistance(sideA, sideB);
  const bound = M + (h / ss) * D + 1e-9;
  const got = maxStep(blend);
  console.log(`${label}: groesster Schritt im Wechsel ${got.m.toFixed(4)} px, ` +
              `Atmen allein ${M.toFixed(4)} px, Abstand der Stimmungen ${D.toFixed(4)} px, ` +
              `Grenze ${bound.toFixed(4)} px`);
  if (got.m > bound) {
    fail(`${label}: der Wechsel springt ${got.m.toFixed(4)} px bei t=${(t0 + got.at * h).toFixed(4)}, ` +
         `erlaubt sind ${bound.toFixed(4)}`);
  }
  /* The same switch as a hard cut, to show the bound has teeth. */
  const cutFig = Object.assign({}, fig, { motion: Object.assign({}, fig.motion, { stateSeconds: 0 }) });
  const cut = maxStep(stepsOf(cutFig, () => ({ state: { from: 'neutral', to, since } }), t0, t1, h));
  console.log(`${label}: derselbe Wechsel als harter Schnitt springt ${cut.m.toFixed(4)} px`);
  if (cut.m <= bound) fail(`${label}: ein harter Schnitt bleibt unter der Grenze, die Pruefung faengt keinen Sprung`);
  stateChecks += blend.length + 1;
}

/* --- live face input -----------------------------------------------------
 *
 * ctx.blink and ctx.mouth come from a camera and change every frame. The
 * answer for one (t, ctx) still must not: same inputs, same frame, with
 * other faces solved in between. ctx is frozen, so a solve that wrote into it
 * would throw here in strict mode instead of passing quietly. */

const faceFig = {
  name: 'face',
  size: { width: 1000, height: 1000 },
  motion: { followSeconds: 0.085, parallax: 0.4, stateSeconds: 0.4 },
  layers: [
    { id: 'kopf', src: 'kopf.webp', pivot: [0.5, 0.6], depth: 0.45,
      motions: [{ type: 'gaze' }, { type: 'blink' }] },
    { id: 'auf', src: 'auf.webp', parent: 'kopf', role: 'eyesOpen', pivot: [0.5, 0.4],
      motions: [{ type: 'blink' }] },
    { id: 'zu', src: 'zu.webp', parent: 'kopf', role: 'eyesClosed', pivot: [0.5, 0.4] },
    { id: 'mund-auf', src: 'mund-auf.webp', parent: 'kopf', role: 'mouthOpen', pivot: [0.5, 0.7] },
    { id: 'mund-zu', src: 'mund-zu.webp', parent: 'kopf', role: 'mouthClosed', pivot: [0.5, 0.7],
      motions: [{ type: 'blink' }] }
  ],
  states: {
    grin: { 'mund-zu': { src: 'mund-zu-grin.webp' }, kopf: { tilt: 2 } },
    stumm: { 'mund-auf': { hidden: true } }
  }
};
const FACE_INPUTS = [
  {}, { blink: 0 }, { blink: 1 }, { blink: 0.37, mouth: 0.8 }, { mouth: 0.5 }, { mouth: 0.51 },
  { blink: NaN, mouth: 'open' }, { blink: -4, mouth: 9 }, { blink: undefined, mouth: undefined }
];
let faceChecks = 0, faceDiffers = 0;
for (const t of TIMES) {
  for (const input of FACE_INPUTS) {
    for (const state of [undefined, 'grin', { from: 'grin', to: 'stumm', since: t - 0.1 }]) {
      const ctx = Object.freeze(Object.assign({ pointerX: 0.2, pointerY: -0.3, state }, input));
      const a = JSON.stringify(Idle.solve(faceFig, t, ctx));
      Idle.solve(faceFig, t, { blink: 1, mouth: 1, state: 'stumm' });
      Idle.solve(faceFig, t + 0.07, { blink: 0.2, mouth: 0 });
      Idle.solve(synthetic, t, { blink: 0.9, mouth: 0.9 });
      const b = JSON.stringify(Idle.solve(faceFig, t, ctx));
      if (a !== b) fail(`face mit ${JSON.stringify(input)} state=${JSON.stringify(state)} bei t=${t} nicht stabil`);
      for (const s of JSON.parse(a)) {
        if (!s.matrix.every(Number.isFinite) || !Number.isFinite(s.opacity) || !Number.isFinite(s.blink)) {
          fail(`face mit ${JSON.stringify(input)} bei t=${t}: Ebene ${s.id} hat NaN`);
        }
      }
      if (a !== JSON.stringify(Idle.solve(faceFig, t, { pointerX: 0.2, pointerY: -0.3, state }))) faceDiffers++;
      faceChecks++;
    }
  }
}
/* The inputs must actually reach the figure, or all of the above is a
 * frozen face passing a purity test. */
if (faceDiffers === 0) fail('face: blink und mouth aendern nie etwas - die Eingabe kommt nicht an');
stateChecks += faceChecks;

checks += stateChecks;
console.log(`${checks} Vergleiche, alle stabil, Bewegung vorhanden.`);
console.log('DETERMINISTISCH');
