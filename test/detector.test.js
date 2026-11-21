import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDetector } from '../src/detector.js';
import { buildLayout } from '../src/piano.js';

const layout = buildLayout({ startMidi: 60, whiteCount: 7, x: 0, y: 0.6, width: 0.7, height: 0.35 });

// A flat hand: wrist at bottom, fingertips in a row. Hand size (wrist->middle MCP) = 0.2.
function hand(id, { cx = 0.35, tipY = 0.5, drops = [0, 0, 0, 0, 0], spread = 0.08 } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: cx, y: tipY + 0.25 }));
  lm[0] = { x: cx, y: tipY + 0.35 }; // wrist
  lm[9] = { x: cx, y: tipY + 0.15 }; // middle MCP
  [4, 8, 12, 16, 20].forEach((t, f) => { lm[t] = { x: cx + (f - 2) * spread, y: tipY + drops[f] }; });
  return { id, landmarks: lm };
}

const run = (det, frames) => frames.flatMap((h, i) => det.update(h, layout, i / 30).events);

test('tap mode: a single finger dropping triggers one note, lifting releases it', () => {
  const det = createDetector({ mode: 'tap', smoothing: 0 });
  const ev = run(det, [
    [hand('R')],
    [hand('R', { drops: [0, 0, 0.08, 0, 0] })], // middle finger dips 0.4 hand-sizes
    [hand('R', { drops: [0, 0, 0.08, 0, 0] })], // held: no new events
    [hand('R')],
  ]);
  assert.deepEqual(ev.map((e) => e.type), ['on', 'off']);
  assert.equal(ev[0].finger, 'R:2');
  assert.ok(ev[0].velocity > 0.35 && ev[0].velocity <= 1);
});

test('tap mode: lowering the whole hand does not trigger notes', () => {
  const det = createDetector({ mode: 'tap', smoothing: 0 });
  const ev = run(det, [[hand('R', { tipY: 0.4 })], [hand('R', { tipY: 0.7 })], [hand('R', { tipY: 0.8 })]]);
  assert.equal(ev.length, 0);
});

test('tap mode: thumb ignored unless enabled', () => {
  const det = createDetector({ mode: 'tap', smoothing: 0 });
  assert.equal(run(det, [[hand('R', { drops: [0.1, 0, 0, 0, 0] })]]).length, 0);
  det.setOptions({ useThumb: true });
  assert.equal(run(det, [[hand('R', { drops: [0.1, 0, 0, 0, 0] })]]).filter((e) => e.type === 'on').length, 1);
});

test('tap mode: hysteresis keeps note held between thresholds', () => {
  const det = createDetector({ mode: 'tap', smoothing: 0, pressThreshold: 0.3, releaseThreshold: 0.15 });
  const ev = run(det, [
    [hand('R', { drops: [0, 0.07, 0, 0, 0] })], // 0.35 -> press
    [hand('R', { drops: [0, 0.04, 0, 0, 0] })], // 0.2  -> still held
    [hand('R', { drops: [0, 0.02, 0, 0, 0] })], // 0.1  -> release
  ]);
  assert.deepEqual(ev.map((e) => e.type), ['on', 'off']);
});

test('zone mode: fingertips entering keyboard play the key under them, sliding changes notes', () => {
  const det = createDetector({ mode: 'zone', smoothing: 0 });
  const above = { x: 0.05, y: 0.4 };
  const mk = (p) => { const h = hand('L'); [4, 8, 16, 20].forEach((t) => (h.landmarks[t] = { x: 0.9, y: 0.1 })); h.landmarks[12] = p; return [h]; };
  const ev = run(det, [mk(above), mk({ x: 0.05, y: 0.9 }), mk({ x: 0.15, y: 0.9 }), mk(above)]);
  assert.deepEqual(ev.map((e) => `${e.type}${e.midi}`), ['on60', 'off60', 'on62', 'off62']);
});

test('hand disappearing releases its notes', () => {
  const det = createDetector({ mode: 'tap', smoothing: 0 });
  const ev = run(det, [[hand('R', { drops: [0, 0, 0.08, 0, 0] })], []]);
  assert.deepEqual(ev.map((e) => e.type), ['on', 'off']);
});

test('two hands are tracked independently', () => {
  const det = createDetector({ mode: 'tap', smoothing: 0 });
  const ev = run(det, [[
    hand('L', { cx: 0.15, drops: [0, 0.08, 0, 0, 0], spread: 0.03 }),
    hand('R', { cx: 0.55, drops: [0, 0, 0, 0, 0.08], spread: 0.03 }),
  ]]);
  assert.equal(ev.length, 2);
  assert.notEqual(ev[0].midi, ev[1].midi);
});
