/*
 * Proves the DOM renderer and the canvas renderer show the same thing.
 *
 * They did not always. A layer with a ONE-entry `frames` array plus a burst
 * flipbook stayed visible forever in the page, because the DOM path only
 * switched frames when there was more than one image, while the canvas path
 * hid it between bursts. Measured on the shipped priest: visible at 71 of 71
 * sample points in the DOM, hidden at 68 of them on canvas.
 *
 * The fix was to give both paths one shared decision, frameOf(). This test
 * pins that decision down and refuses a second opinion creeping back in.
 *
 *   node tools/test-agreement.mjs
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

let checks = 0;

/* --- 1. frameOf contract ------------------------------------------------ */

const plain = { id: 'p', src: 'a.webp' };
if (Idle.frameOf(plain, { frame: -2 }) !== 0) fail('Ebene ohne frames muss immer Bild 0 zeigen');
if (Idle.frameOf(plain, { frame: -1 }) !== 0) fail('Ebene ohne frames darf nie unsichtbar werden');
checks += 2;

/* A frames array of length one is the case that broke. It must behave
 * exactly like a longer one. */
for (const n of [1, 2, 4]) {
  const L = { id: 'f', frames: Array.from({ length: n }, (_, i) => i + '.webp') };
  if (Idle.frameOf(L, { frame: -1 }) !== -1) fail(`frames=${n}: -1 muss unsichtbar bleiben`);
  if (Idle.frameOf(L, { frame: -2 }) !== 0) fail(`frames=${n}: ohne Daumenkino muss Bild 0 kommen`);
  for (let k = 0; k < n * 3; k++) {
    const got = Idle.frameOf(L, { frame: k });
    if (got < 0 || got >= n) fail(`frames=${n}: Index ${k} ergab ${got}, ausserhalb 0..${n - 1}`);
  }
  checks += 2 + n * 3;
}

/* --- 2. the real figure, over a real timeline ---------------------------- */

const priestPath = join(root, 'figures', 'priest', 'figure.json');
if (existsSync(priestPath)) {
  const fig = JSON.parse(readFileSync(priestPath, 'utf8'));
  const single = (fig.layers || []).filter(L => L.frames && L.frames.length === 1);
  if (!single.length) {
    console.log('Hinweis: der Priester hat gerade keine Ein-Bild-Ebene, der Fall bleibt trotzdem gepruefte Regel.');
  }
  let hiddenSomewhere = 0;
  for (const L of single) {
    for (let i = 0; i <= 200; i++) {
      const t = i / 10;
      const st = Idle.solve(fig, t, { pointerX: 0, pointerY: 0 }).find(s => s.id === L.id);
      if (Idle.frameOf(L, st) === -1) hiddenSomewhere++;
      checks++;
    }
  }
  if (single.length && hiddenSomewhere === 0) {
    fail('eine Ein-Bild-Ebene mit Burst war ueber 20 s nie unsichtbar - der alte Fehler ist zurueck');
  }
}

/* --- 3. no second opinion in the source --------------------------------- */

const src = readFileSync(join(root, 'player', 'idle.js'), 'utf8');
const body = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
const strayVisibility = body.match(/(?:s2?|st)\.frame\s*(?:===?|!==?|<|>)/g) || [];
const insideFrameOf = (body.match(/function frameOf[\s\S]*?\n  \}/) || [''])[0];
const allowed = (insideFrameOf.match(/(?:s2?|st)\.frame\s*(?:===?|!==?|<|>)/g) || []).length;
if (strayVisibility.length > allowed) {
  fail(`${strayVisibility.length - allowed} Sichtbarkeits-Vergleich(e) auf .frame ausserhalb von frameOf - ` +
       'genau so sind die beiden Zeichner das letzte Mal auseinandergelaufen');
}
checks++;

/* --- 4. blend translation ------------------------------------------------ */

const CANVAS_OPS = new Set(['source-over', 'lighter', 'multiply', 'screen', 'overlay',
  'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);
for (const css of ['normal', 'plus-lighter', 'plus-darker', 'screen', 'multiply', 'overlay', '']) {
  const op = Idle.canvasBlend(css);
  if (!CANVAS_OPS.has(op)) fail(`Mischmodus "${css}" wird zu "${op}", das Canvas kennt das nicht`);
  checks++;
}

/* --- 5. opacity stays a legal number ------------------------------------- */

const hot = {
  name: 'hot', size: { width: 100, height: 100 }, motion: {},
  layers: [{ id: 'g', src: 'g.webp', pivot: [0.5, 0.5],
             motions: [{ type: 'glow', strength: 3, min: 0.1 }] }]
};
for (let i = 0; i <= 400; i++) {
  const st = Idle.solve(hot, i / 20, {})[0];
  if (!(st.opacity >= 0 && st.opacity <= 1)) {
    fail(`Deckkraft ${st.opacity} bei t=${i / 20} liegt ausserhalb 0..1`);
  }
  checks++;
}

/* --- 6. the studio's parameter list must match the engine ---------------- */

const studio = readFileSync(join(root, 'studio', 'studio.js'), 'utf8');
const engine = readFileSync(join(root, 'player', 'idle.js'), 'utf8');
const motionsBlock = engine.slice(engine.indexOf('var MOTIONS = {'), engine.indexOf('function frameOf'));
const paramsBlock = studio.slice(studio.indexOf('var MOTION_PARAMS = {'),
                                 studio.indexOf('function buildMotionControls'));

for (const name of ['breathe', 'sway', 'blink', 'gaze', 'flipbook', 'glow', 'charge', 'drift']) {
  const i = motionsBlock.indexOf(name + ': function');
  if (i < 0) fail(`Baustein ${name} fehlt im Motor`);
  const body = motionsBlock.slice(i, motionsBlock.indexOf('},', i));
  const read = new Set([...body.matchAll(/cfg\.([a-zA-Z]+)/g)].map(m => m[1]));
  read.delete('mode');
  read.delete('fadeOut');

  const row = paramsBlock.match(new RegExp(name + '\\s*:\\s*\\{([^}]*)\\}'));
  if (!row) fail(`Baustein ${name} fehlt in MOTION_PARAMS des Studios`);
  const listed = new Set([...row[1].matchAll(/([a-zA-Z]+)\s*:/g)].map(m => m[1]));

  for (const k of read) {
    if (!listed.has(k)) fail(`${name}: Motor liest "${k}", das Studio bietet keinen Regler dafuer`);
  }
  for (const k of listed) {
    if (!read.has(k)) fail(`${name}: Studio bietet "${k}" an, der Motor liest es nie`);
  }
  checks += read.size + listed.size;
}

/* --- 6b. every parameter the studio offers must have a usable range ------
 *
 * drift shipped without one. The fallback range is 0..10, so the slider for
 * its default dy of -120 could not reach the value it was showing: a block
 * you could add and not steer. A missing entry is now a failure, and so is a
 * default that falls outside its own slider. */

const rangesBlock = studio.slice(studio.indexOf('var RANGES = {'),
                                 studio.indexOf('function slider'));
const RANGES = new Function(rangesBlock + '\nreturn RANGES;')();
const MP = new Function(paramsBlock + '\nreturn MOTION_PARAMS;')();

/* The four the panel writes outside a motion block. */
const extraKeys = ['depth', 'lag', 'parallax', 'opacity'];

for (const type of Object.keys(MP)) {
  for (const [key, def] of Object.entries(MP[type])) {
    const r = RANGES[key];
    if (!r) fail(`${type}.${key} hat keinen Eintrag in RANGES - der Regler liefe auf 0..10`);
    const [lo, hi, step] = r;
    if (!(lo < hi)) fail(`RANGES.${key}: ${lo} ist nicht kleiner als ${hi}`);
    if (!(step > 0)) fail(`RANGES.${key}: Schrittweite ${step} ist nicht groesser als 0`);
    if (def < lo || def > hi) {
      fail(`${type}.${key}: Standardwert ${def} liegt ausserhalb des Reglers ${lo}..${hi}`);
    }
    checks += 4;
  }
}
for (const key of extraKeys) {
  if (!RANGES[key]) fail(`RANGES fehlt "${key}", das die Karte "Layer" oder "figure" schreibt`);
  checks++;
}
console.log(`Reglerbereiche: ${checks} Pruefungen bis hierhin, jeder Standardwert erreichbar.`);

/* --- 6c. the parent-chain guard ------------------------------------------
 *
 * A ring in `parent` freezes the tab: chainDepth() walks the chain on every
 * frame. The studio keeps one out by hand - the dropdown hides everything
 * below the layer - and refuses one that arrives through the JSON box. Both
 * come from the functions below, so they are lifted out of studio.js and run
 * here rather than trusted. */

const guardSrc = studio.slice(studio.indexOf('function descendantIds'),
                              studio.indexOf('/* end of the parent-chain guard */'));
const guard = new Function(guardSrc +
  '\nreturn { descendantIds, cycleTrouble, figureTrouble };')();

const L = (id, parent) => ({ id, src: id + '.webp', parent });
const kette = [L('a'), L('b', 'a'), L('c', 'b')];

const unten = guard.descendantIds(kette, 'a');
for (const id of ['a', 'b', 'c']) {
  if (!unten[id]) fail(`descendantIds: "${id}" haengt unter "a" und fehlt`);
  checks++;
}
const untenC = guard.descendantIds(kette, 'c');
if (untenC.a || untenC.b) fail('descendantIds: "c" hat weder a noch b unter sich');
checks++;

if (guard.cycleTrouble(kette) !== null) fail('cycleTrouble meldet einen Fehler in einer sauberen Kette');
checks++;

const ring = [L('a', 'c'), L('b', 'a'), L('c', 'b')];
const ringMsg = guard.cycleTrouble(ring);
if (!ringMsg || !/loop/.test(ringMsg)) fail(`cycleTrouble erkennt den Ring a->b->c->a nicht: ${ringMsg}`);
checks++;

/* The set has to close on a figure that already contains a ring, or the
 * dropdown itself hangs the moment such a figure is applied. */
const ringUnten = guard.descendantIds(ring, 'a');
if (!(ringUnten.a && ringUnten.b && ringUnten.c)) fail('descendantIds haelt einen Ring nicht aus');
checks++;

const fehlt = guard.cycleTrouble([L('a', 'gibtsnicht')]);
if (!fehlt || !/not a layer/.test(fehlt)) fail(`cycleTrouble erkennt einen fehlenden Elternteil nicht: ${fehlt}`);
checks++;

const gut = { layers: kette };
if (guard.figureTrouble(gut) !== null) fail('figureTrouble lehnt eine saubere Figur ab');
checks++;
for (const [fig, muster] of [
  [{ layers: [L('a'), L('a')] }, /share the id/],
  [{ layers: [{ id: 'a' }] }, /neither src nor frames/],
  [{ layers: [] }, /at least one layer/],
  [{ layers: kette.concat([L('d', 'e')]) }, /not a layer/],
  ['nein', /object/]
]) {
  const msg = guard.figureTrouble(fig);
  if (!msg || !muster.test(msg)) fail(`figureTrouble: erwartet ${muster}, bekommen ${msg}`);
  checks++;
}
console.log(`Elternkette: Ring, fehlender Elternteil und doppelte id werden abgewiesen.`);

/* --- 6d. the part vocabulary the studio offers ---------------------------
 *
 * A marked part is named by hand, and the name is the whole rig: "kopf"
 * gives a neck pivot and a gaze, an unrecognised word gives a whisper of
 * sway and nothing else. The studio offers the words while someone types,
 * and gets them from GET /_vocab - but it carries a built-in list for a
 * read-only server, and that list is a second copy of a table in Python.
 *
 * So the copy is held to the original: it may not miss a word that works,
 * and it may not offer one that does not. */

const importer = readFileSync(join(root, 'tools', 'import-layers.py'), 'utf8');

const kindsBlock = importer.slice(importer.indexOf('KINDS = ['),
                                  importer.indexOf('def kind_of'));
const echteWorte = new Set();
for (const m of kindsBlock.matchAll(/\(\s*"(\w+)"\s*,\s*\(([^)]*)\)\s*\)/g)) {
  for (const w of m[2].matchAll(/"(\w+)"/g)) echteWorte.add(w[1]);
}
if (echteWorte.size < 20) fail(`KINDS aus import-layers.py nicht gelesen, nur ${echteWorte.size} Woerter`);

const germanBlock = importer.slice(importer.indexOf('GERMAN = {'),
                                   importer.indexOf('def canon'));
const deutscheWorte = new Set(
  [...germanBlock.matchAll(/"([a-z]+)"\s*:/g)].map(m => m[1]));

const fallbackBlock = studio.slice(studio.indexOf('var VOCAB_FALLBACK = ['),
                                   studio.indexOf('function loadVocab'));
const fallback = new Set(
  [...fallbackBlock.matchAll(/'([a-z-]+)'/g)].map(m => m[1]));

for (const w of echteWorte) {
  if (!fallback.has(w)) {
    fail(`import-layers.py rigged "${w}", die Notliste des Studios kennt es nicht`);
  }
  checks++;
}
for (const w of fallback) {
  if (!echteWorte.has(w) && !deutscheWorte.has(w)) {
    fail(`das Studio bietet "${w}" an, import-layers.py macht damit nichts`);
  }
  checks++;
}
console.log(`Teilwoerter: ${echteWorte.size} aus dem Importer, Notliste deckt sie.`);

/* --- 6e. the period clash warning ----------------------------------------
 *
 * Principle 8 said "the tool does not help yet". The Motion card now warns
 * when two periods lock, and the rule behind the warning is held here. */

const clashSrc = studio.slice(studio.indexOf('/* period clash check */'),
                              studio.indexOf('/* end of the period clash check */'));
if (!clashSrc) fail('periodClashes nicht zwischen seinen Markern gefunden');
const { periodClashes } = new Function(clashSrc + '\nreturn { periodClashes };')();

const P = (id, motions) => ({ id, src: id, motions });
const pc = (layers, id) => periodClashes({ layers }, id, MP);
const kinds = (layers, id) => pc(layers, id).map(c => c.kind + ':' + c.id).sort().join(',');

for (const [label, layers, id, want] of [
  ['4.0 gegen 4.0', [P('a', [{ type: 'breathe', period: 4 }]), P('b', [{ type: 'sway', period: 4 }])], 'a', 'same:b'],
  ['4.0 gegen 8.0', [P('a', [{ type: 'breathe', period: 4 }]), P('b', [{ type: 'sway', period: 8 }])], 'a', 'double:b'],
  ['8.0 gegen 4.0', [P('a', [{ type: 'sway', period: 8 }]), P('b', [{ type: 'breathe', period: 4 }])], 'a', 'double:b'],
  ['4.0 gegen 7.5', [P('a', [{ type: 'breathe', period: 4 }]), P('b', [{ type: 'sway', period: 7.5 }])], 'a', ''],
  ['6.85 gegen 6.8 ist gleich', [P('a', [{ type: 'sway', period: 6.85 }]), P('b', [{ type: 'sway', period: 6.8 }])], 'a', 'same:b'],
  ['7.5 gegen 7.4 ist gestaffelt', [P('a', [{ type: 'sway', period: 7.5 }]), P('b', [{ type: 'sway', period: 7.4 }])], 'a', ''],
  ['3.0 gegen 6.1 ist nicht doppelt', [P('a', [{ type: 'sway', period: 3 }]), P('b', [{ type: 'sway', period: 6.1 }])], 'a', ''],
  ['fehlende Periode ist der Standard', [P('a', [{ type: 'breathe' }]), P('b', [{ type: 'glow', period: 4 }])], 'a', 'same:b'],
  ['Periode 0 ist der Standard', [P('a', [{ type: 'breathe', period: 0 }]), P('b', [{ type: 'breathe' }])], 'a', 'same:b'],
  ['Staerke 0 zaehlt nicht', [P('a', [{ type: 'breathe', period: 4 }]), P('b', [{ type: 'breathe', period: 4, strength: 0 }])], 'a', ''],
  ['blink hat keine Periode', [P('a', [{ type: 'breathe', period: 4.2 }]), P('b', [{ type: 'blink', interval: 4.2 }])], 'a', ''],
  ['eigene zweite Bewegung', [P('a', [{ type: 'breathe', period: 5.3 }, { type: 'glow' }])], 'a', 'same:a'],
  ['nichts gewaehlt', [P('a', [{ type: 'breathe' }]), P('b', [{ type: 'breathe' }])], null, ''],
  ['Ebene ohne Bewegung', [P('a', []), P('b', [{ type: 'breathe' }])], 'a', ''],
  ['zwei Pupillen schauen zusammen', [P('a', [{ type: 'gaze', period: 9.7 }]), P('b', [{ type: 'gaze', period: 9.7 }])], 'a', ''],
  ['gaze gegen sway zaehlt', [P('a', [{ type: 'gaze', period: 7.5 }]), P('b', [{ type: 'sway', period: 7.5 }])], 'a', 'same:b']
]) {
  const got = kinds(layers, id);
  if (got !== want) fail(`periodClashes ${label}: erwartet "${want}", bekommen "${got}"`);
  checks++;
}

/* Two real figures, when they are on this machine (figures/ is not in git).
 * Kriegerin: the bear's head and the warrior's hair are two bodies and both
 * sway at 7.5 s. Pedro: his pupils share a gaze period and must stay quiet. */
const figPath = n => join(root, 'figures', n, 'figure.json');
if (existsSync(figPath('kriegerin'))) {
  const kf = JSON.parse(readFileSync(figPath('kriegerin'), 'utf8'));
  if (!periodClashes(kf, 'bear-kopf', MP).some(c => c.kind === 'same' && c.id === 'krieger-kopf-haare')) {
    fail('Kriegerin: bear-kopf und krieger-kopf-haare schwingen beide mit 7.5 s, die Warnung schweigt');
  }
  checks++;
}
if (existsSync(figPath('pedro'))) {
  const pf = JSON.parse(readFileSync(figPath('pedro'), 'utf8'));
  if (periodClashes(pf, 'pupille-links', MP).length) {
    fail('Pedro: die Pupillen schauen gewollt zusammen, die Warnung meldet sie trotzdem');
  }
  checks++;
}
console.log('Perioden: gleich und doppelt werden gemeldet, 4.0 gegen 7.5 nicht.');

/* --- 7. hostile input must not crash, hang or split the renderers -------- */

const F = (layers, extra) => Object.assign(
  { size: { width: 100, height: 100 }, motion: {}, layers }, extra || {});
const finite = (st) => st.every(s =>
  s.matrix.every(Number.isFinite) && Number.isFinite(s.opacity) &&
  s.opacity >= 0 && s.opacity <= 1);

const hostile = [
  ['interval 0 (hing die Schleife auf)', F([{ id: 'a', src: 'x', pivot: [0.5, 0.5],
      role: 'eyesOpen', motions: [{ type: 'blink', interval: 0 }] }])],
  ['period 0', F([{ id: 'a', src: 'x', pivot: [0.5, 0.5],
      motions: [{ type: 'breathe', period: 0 }, { type: 'sway', period: 0 },
                { type: 'gaze', period: 0 }, { type: 'glow', period: 0 }] }])],
  ['pivot zu kurz', F([{ id: 'a', src: 'x', pivot: [0.5] }])],
  ['pivot als Objekt', F([{ id: 'a', src: 'x', pivot: { x: 1, y: 2 } }])],
  ['pivot fehlt', F([{ id: 'a', src: 'x' }])],
  ['Deckkraft -1', F([{ id: 'a', src: 'x', pivot: [0.5, 0.5], opacity: -1 }])],
  ['Deckkraft 5', F([{ id: 'a', src: 'x', pivot: [0.5, 0.5], opacity: 5 }])],
  ['id constructor', F([{ id: 'constructor', src: 'x', pivot: [0.5, 0.5] }])],
  ['id __proto__', F([{ id: '__proto__', src: 'x', pivot: [0.5, 0.5] }])],
  ['Elternteil zeigt ins Leere', F([{ id: 'a', src: 'x', pivot: [0.5, 0.5], parent: 'ghost' }])],
  ['Elternteil ist man selbst', F([{ id: 'a', src: 'x', pivot: [0.5, 0.5], parent: 'a' }])],
  ['Zweierschleife', F([{ id: 'a', src: 'x', pivot: [0.5, 0.5], parent: 'b' },
                        { id: 'b', src: 'y', pivot: [0.5, 0.5], parent: 'a' }])],
  ['fps 0, every 0', F([{ id: 'a', frames: ['1', '2'], pivot: [0.5, 0.5],
      motions: [{ type: 'flipbook', mode: 'burst', fps: 0, every: 0 }] }])],
  ['keine Ebenen', F([])]
];

for (const [label, fig] of hostile) {
  for (const t of [0, 0.5, 3.7, 61.2]) {
    const started = Date.now();
    let st;
    try { st = Idle.solve(fig, t, { pointerX: 0.3, pointerY: -0.7 }); }
    catch (e) { fail(`${label} bei t=${t} warf: ${e.message}`); }
    if (Date.now() - started > 2000) fail(`${label} bei t=${t} brauchte ueber 2 s`);
    if (!finite(st)) fail(`${label} bei t=${t} ergab NaN oder eine Deckkraft ausserhalb 0..1`);
    checks++;
  }
}

/* Duplicate ids must keep separate transforms, or the two renderers disagree:
 * the DOM keeps one node and leaves the other unstyled, the canvas draws both
 * with the survivor's matrix. */
const dup = Idle.solve(F([
  { id: 'd', src: 'x', pivot: [0.5, 0.5], motions: [{ type: 'sway', strength: 3, degrees: 12 }] },
  { id: 'd', src: 'y', pivot: [0.5, 0.5] }
]), 1.3, {});
if (dup[0].css === dup[1].css) fail('doppelte id: beide Ebenen bekamen dieselbe Matrix');
checks++;

/* A dangling parent must not cost a follow-through step. */
const ghost = Idle.solve(F([{ id: 'g', src: 'x', pivot: [0.5, 0.5], parent: 'ghost',
  motions: [{ type: 'breathe' }] }]), 2.1, {});
const solo = Idle.solve(F([{ id: 'g', src: 'x', pivot: [0.5, 0.5],
  motions: [{ type: 'breathe' }] }]), 2.1, {});
if (ghost[0].css !== solo[0].css) fail('ein Elternteil ins Leere verschob die Ebene in der Zeit');
checks++;

/* role eyesOpen must work whether the blink sits on that layer or above it. */
const inherited = F([
  { id: 'head', src: 'h', pivot: [0.5, 0.5], motions: [{ type: 'blink' }] },
  { id: 'eyes', src: 'e', parent: 'head', pivot: [0.5, 0.5], role: 'eyesOpen' }
]);
let closed = 0;
for (let i = 0; i < 6000; i++) if (Idle.solve(inherited, i / 100, {})[1].hidden) closed++;
if (closed === 0) fail('role eyesOpen erbt das Blinzeln nicht vom Elternteil');
checks += 6000;

/* drift must not jump between two frames.
 *
 * It did. Jitter was allowed to push a rise so late that it was still running
 * when the next one came due; the solver then had to pick one of the two, and
 * the layer cut from the old opacity straight to the new one in a single
 * frame. On grim that was a 0.62 step, and it read as the whole spray
 * flickering. The engine now spends only the part of the slot the rise leaves
 * free, so the steepest change possible is the fade ramp itself.
 *
 * The parameters below are the ones that used to break it: a rise filling
 * most of its slot, with the jitter turned up past what is left. */
const rampe = (life) => (1 / 60) / (life * 0.125);   /* fade-in per 60 fps frame */
for (const [life, every, jitter] of [[3.6, 5.17, 0.9], [3.0, 3.0, 1.0],
                                     [2.0, 9.0, 0.95], [4.0, 4.2, 0.6]]) {
  const dr = F([{ id: 'p', src: 'x', pivot: [0.5, 0.5],
    motions: [{ type: 'drift', dx: 20, dy: -80, life, every, jitter }] }]);
  let vor = Idle.solve(dr, 0, {})[0].opacity, groesster = 0, wann = 0;
  for (let i = 1; i < 60 * 400; i++) {
    const o = Idle.solve(dr, i / 60, {})[0].opacity;
    const d = Math.abs(o - vor);
    if (d > groesster) { groesster = d; wann = i / 60; }
    vor = o;
  }
  /* A little headroom: the ease-out means the last frame of a rise is not
   * exactly on the ramp. */
  const grenze = rampe(life) * 1.5;
  if (groesster > grenze) {
    fail(`drift life=${life} every=${every} jitter=${jitter}: Deckkraft springt `
       + `${groesster.toFixed(3)} in einem Bild bei t=${wann.toFixed(2)}, `
       + `erlaubt sind ${grenze.toFixed(3)} - das flimmert`);
  }
  checks += 60 * 400;
}

/* --- 8. crop: one rectangle, the same for both renderers -----------------
 *
 * The loading screen's fork read crop without looking at it. A malformed
 * value reached the DOM as "undefinedpx", which the browser drops, so the
 * image showed at full size - and reached drawImage as NaN, which draws
 * nothing. cropOf now decides once, and both renderers must ask it. */

const R = [10, 20, 30, 40];
const cropCases = [
  ['crop auf src-Ebene', { src: 'a', crop: R }, 0, R],
  ['crop gilt fuer jedes Bild', { frames: ['a', 'b'], crop: R }, 1, R],
  ['crops gewinnt', { frames: ['a', 'b'], crop: [0, 0, 1, 1], crops: [R, [1, 2, 3, 4]] }, 1, [1, 2, 3, 4]],
  ['crops ohne diesen Index', { frames: ['a', 'b'], crop: R, crops: [R] }, 1, null],
  ['ohne crop', { src: 'a' }, 0, null],
  ['crop als Objekt', { src: 'a', crop: { x: 1, y: 2, w: 3, h: 4 } }, 0, null],
  ['crop mit 3 Zahlen', { src: 'a', crop: [1, 2, 3] }, 0, null],
  ['crop mit NaN', { src: 'a', crop: [1, NaN, 3, 4] }, 0, null],
  ['crop mit Text', { src: 'a', crop: ['1', 2, 3, 4] }, 0, null],
  ['crop Breite 0', { src: 'a', crop: [1, 2, 0, 4] }, 0, null],
  ['crop Hoehe negativ', { src: 'a', crop: [1, 2, 3, -4] }, 0, null],
  ['crops kein Array', { frames: ['a'], crops: { 0: R } }, 0, null]
];
for (const [label, layer, idx, want] of cropCases) {
  const got = Idle.cropOf(layer, idx);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail(`cropOf ${label}: erwartet ${JSON.stringify(want)}, bekommen ${JSON.stringify(got)}`);
  }
  checks++;
}

/* Both renderers have to go through cropOf, or they split again. */
const buildBody = (body.match(/IdleFigure\.prototype\._build = function[\s\S]*?\n  \};/) || [''])[0];
const drawBody = (body.match(/function drawFrame[\s\S]*?\n  \}/) || [''])[0];
if (!/cropOf\(L, k\)/.test(buildBody)) fail('_build fragt cropOf nicht - die Seite ignoriert crop');
if (!/cropOf\(L, fi\)/.test(drawBody)) fail('drawFrame fragt cropOf nicht - der Bilderstreifen ignoriert crop');
if (/\.crops?\b/.test(body.replace(/function cropOf[\s\S]*?\n  \}/, ''))) {
  fail('crop wird ausserhalb von cropOf gelesen - eine zweite Meinung');
}
checks += 3;

/* A cropped figure draws its image into the rectangle, an uncropped one
 * across the whole canvas. Recorded on a fake context. */
const calls = [];
const g = {
  setTransform() {}, clearRect() {}, save() {}, restore() {},
  drawImage(img, x, y, w, h) { calls.push([img, x, y, w, h]); }
};
const cropFig = F([{ id: 'c', src: 'c', pivot: [0.5, 0.5], crop: R },
                   { id: 'n', src: 'n', pivot: [0.5, 0.5] }]);
Idle.drawFrame(g, cropFig, { _bg: null, c: ['IMG-C'], n: ['IMG-N'] }, 0, {});
if (JSON.stringify(calls) !== JSON.stringify([['IMG-C', 10, 20, 30, 40], ['IMG-N', 0, 0, 100, 100]])) {
  fail(`drawFrame zeichnet crop falsch: ${JSON.stringify(calls)}`);
}
checks++;
console.log('crop: cropOf entscheidet allein, beide Zeichner fragen es.');

/* --- 9. pointer input reaches touch too ---------------------------------- */

const listened = {};
const pad = {
  addEventListener(type, fn) { listened[type] = fn; },
  getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 100 }; }
};
const me = { _bound: [], pointerX: 0, pointerY: 0 };
Idle.IdleFigure.prototype.trackPointer.call(me, pad);
for (const t of ['pointermove', 'pointerleave', 'pointercancel']) {
  if (!listened[t]) fail(`trackPointer hoert nicht auf ${t}`);
  checks++;
}
if (listened.mousemove || listened.mouseleave) fail('trackPointer hoert noch auf Maus-Ereignisse');
if (me._bound.length !== 3) fail(`destroy() kennt ${me._bound.length} statt 3 Zuhoerer`);
listened.pointermove({ clientX: 150, clientY: 25 });
if (me.pointerX !== 0.5 || me.pointerY !== -0.5) fail(`pointermove ergab ${me.pointerX}/${me.pointerY}`);
listened.pointercancel();
if (me.pointerX !== 0 || me.pointerY !== 0) fail('pointercancel stellt den Blick nicht zurueck');
checks += 4;

console.log(`${checks} Pruefungen, Seite und Bilderstreifen entscheiden identisch.`);
console.log('EINIG');
