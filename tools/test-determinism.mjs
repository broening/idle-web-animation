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

console.log(`${checks} Vergleiche, alle stabil, Bewegung vorhanden.`);
console.log('DETERMINISTISCH');
