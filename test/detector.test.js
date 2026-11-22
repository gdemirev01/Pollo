import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../src/detector.js';
import { buildLayout, hitTest } from '../src/piano.js';

const layout = buildLayout({ startMidi: 60, whiteCount: 7, x: 0, y: 0.55, width: 0.7, height: 0.4 });
const FPS = 30;

// Camera in front: knuckles at y = 0.6, fingertips resting a little lower (on the
// table, toward the camera). Hand size (wrist -> middle knuckle) = 0.2.
// lift[f] raises fingertip f by that many hand-sizes; dy moves the whole hand.
function frontHand(id, { lift = [0, 0, 0, 0, 0], cx = 0.35, dy = 0 } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: cx, y: 0.65 + dy, z: 0 }));
  lm[0] = { x: cx, y: 0.4 + dy, z: 0 }; // wrist (further from camera = higher up)
  [2, 5, 9, 13, 17].forEach((b, f) => (lm[b] = { x: cx + (f - 2) * 0.06, y: 0.6 + dy, z: 0 }));
  [4, 8, 12, 16, 20].forEach((t, f) => (lm[t] = { x: cx + (f - 2) * 0.06, y: 0.66 + dy - lift[f] * 0.2, z: 0 }));
  return { id, landmarks: lm };
}
const lifted = (f, a) => { const l = [0, 0, 0, 0, 0]; l[f] = a; return l; };
const run = (det, frames, L = layout) => frames.flatMap((h, i) => det.update(h, L, i / FPS).events);
const rest = (n, mk = () => [frontHand('R')]) => Array.from({ length: n }, mk);

test('tap (front): lift, then a quick tap down plays the key under the fingertip', () => {
  const det = createDetector({ mode: 'tap' });
  const ev = run(det, [
    ...rest(10),
    ...[0.1, 0.2, 0.3, 0.3].map((a) => [frontHand('R', { lift: lifted(2, a) })]), // middle finger lifts
    [frontHand('R', { lift: lifted(2, 0.12) })], // comes down fast
    [frontHand('R')], // hits the table
    ...rest(5), // stays down: no repeats
    ...[0.1, 0.2].map((a) => [frontHand('R', { lift: lifted(2, a) })]), // lifts off: note off
  ]);
  assert.deepEqual(ev.map((e) => e.type), ['on', 'off']);
  assert.equal(ev[0].finger, 'R:2');
  assert.equal(ev[0].midi, hitTest(layout, 0.35, 0.66).midi);
  assert.ok(ev[0].velocity > 0.5);
});

test('tap (front): lowering a finger slowly does not play', () => {
  const det = createDetector({ mode: 'tap' });
  const down = Array.from({ length: 30 }, (_, i) => [frontHand('R', { lift: lifted(1, 0.3 * (1 - i / 29)) })]);
  const ev = run(det, [...rest(10), ...[0.1, 0.2, 0.3].map((a) => [frontHand('R', { lift: lifted(1, a) })]), ...down]);
  assert.equal(ev.length, 0);
});

test('tap (front): moving the whole hand up and down does not play', () => {
  const det = createDetector({ mode: 'tap' });
  const ev = run(det, Array.from({ length: 40 }, (_, i) => [frontHand('R', { dy: 0.1 * Math.sin(i / 3) })]));
  assert.equal(ev.length, 0);
});

test('tap (front): a neighbour twitching along with a tap is ignored, a real chord plays', () => {
  const det = createDetector({ mode: 'tap' });
  const both = (a, b) => [frontHand('R', { lift: [0, 0, a, b, 0] })];
  const twitch = run(det, [...rest(10), both(0.15, 0.08), both(0.3, 0.15), both(0.3, 0.15), both(0, 0)]);
  assert.deepEqual(twitch.map((e) => e.finger), ['R:2']);

  const det2 = createDetector({ mode: 'tap' });
  const chord = run(det2, [...rest(10), both(0.15, 0.15), both(0.3, 0.3), both(0.3, 0.3), both(0, 0)]);
  assert.deepEqual(chord.map((e) => e.finger).sort(), ['R:2', 'R:3']);
});

test('tap: thumb ignored unless enabled', () => {
  const det = createDetector({ mode: 'tap' });
  const seq = [...rest(10), ...[0.15, 0.3, 0.3].map((a) => [frontHand('R', { lift: lifted(0, a) })]), [frontHand('R')]];
  assert.equal(run(det, seq).length, 0);
  const det2 = createDetector({ mode: 'tap', useThumb: true });
  assert.equal(run(det2, seq).filter((e) => e.type === 'on').length, 1);
});

test('tap: a hand leaving releases its notes', () => {
  const det = createDetector({ mode: 'tap' });
  const ev = run(det, [...rest(10), ...[0.15, 0.3, 0.3].map((a) => [frontHand('R', { lift: lifted(1, a) })]), [frontHand('R')], []]);
  assert.deepEqual(ev.map((e) => e.type), ['on', 'off']);
});

test('tap: a strike outside the keyboard plays nothing', () => {
  const det = createDetector({ mode: 'tap' });
  const far = (lift) => [frontHand('R', { lift, cx: 0.9 })];
  const ev = run(det, [...Array.from({ length: 10 }, () => far(lifted(2, 0))), far(lifted(2, 0.15)), far(lifted(2, 0.3)), far(lifted(2, 0.3)), far(lifted(2, 0))]);
  assert.equal(ev.length, 0);
});

// ---- camera above, looking down ----
// Fingers flat on the table; lifting brings the tip toward the camera (z more
// negative) and makes the finger look shorter.
function topHand(id, { lift = [0, 0, 0, 0, 0], cx = 0.35 } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: cx, y: 0.9, z: 0 }));
  lm[0] = { x: cx, y: 0.95, z: 0 };
  [2, 5, 9, 13, 17].forEach((b, f) => (lm[b] = { x: cx + (f - 2) * 0.04, y: 0.8, z: 0 }));
  [4, 8, 12, 16, 20].forEach((t, f) => {
    const L = 0.12 * (1 - 0.4 * lift[f]);
    lm[t] = { x: cx + (f - 2) * 0.04, y: 0.8 - L, z: -0.05 * lift[f] };
  });
  return { id, landmarks: lm };
}

test('surface (above): lift and tap down plays; resting and lifting alone do not', () => {
  const L = buildLayout({ startMidi: 60, whiteCount: 7, x: 0.2, y: 0.55, width: 0.35, height: 0.3 });
  const det = createDetector({ mode: 'surface' });
  const restTop = Array.from({ length: 10 }, () => [topHand('R')]);
  const ev = run(det, [
    ...restTop,
    ...[0.5, 1, 1].map((a) => [topHand('R', { lift: lifted(1, a) })]),
    [topHand('R')],
    ...Array.from({ length: 5 }, () => [topHand('R')]),
    ...[0.5, 1].map((a) => [topHand('R', { lift: lifted(1, a) })]),
  ], L);
  assert.deepEqual(ev.map((e) => e.type), ['on', 'off']);
  assert.equal(ev[0].midi, hitTest(L, 0.31, 0.68).midi);

  const det2 = createDetector({ mode: 'surface' });
  const liftOnly = run(det2, [...restTop, ...[0.5, 1, 1, 1].map((a) => [topHand('R', { lift: lifted(2, a) })])], L);
  assert.equal(liftOnly.length, 0);
  assert.equal(det2.smoothed('R:2').state, 'armed');
});

test('zone: fingertips entering the keyboard play the key under them, sliding changes notes', () => {
  const det = createDetector({ mode: 'zone' });
  const L = buildLayout({ startMidi: 60, whiteCount: 7, x: 0, y: 0.6, width: 0.7, height: 0.35 });
  const mk = (p) => { const h = frontHand('L'); [4, 8, 16, 20].forEach((t) => (h.landmarks[t] = { x: 0.9, y: 0.1 })); h.landmarks[12] = p; return [h]; };
  const ev = run(det, [mk({ x: 0.05, y: 0.4 }), mk({ x: 0.05, y: 0.9 }), mk({ x: 0.15, y: 0.9 }), mk({ x: 0.05, y: 0.4 })], L);
  assert.deepEqual(ev.map((e) => `${e.type}${e.midi}`), ['on60', 'off60', 'on62', 'off62']);
});

test('one glitchy frame does not leave a resting finger reading as lifted', () => {
  const det = createDetector({ mode: 'tap' });
  const glitch = frontHand('R'); glitch.landmarks[12] = { x: 0.35, y: 0.95, z: 0 }; // middle tip jumps far down for one frame
  const ev = run(det, [...rest(15), [glitch], ...rest(3)]);
  assert.equal(ev.length, 0);
  assert.ok(det.smoothed('R:2').signal < 0.05, `reads ${det.smoothed('R:2').signal.toFixed(2)} after the glitch`);
});
