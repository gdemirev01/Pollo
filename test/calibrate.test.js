import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalibrator } from '../src/calibrate.js';
import { createDetector } from '../src/detector.js';
import { buildLayout } from '../src/piano.js';

// Camera above the table at an angle: lifting a finger mostly slides the
// fingertip sideways in the picture, with only a little depth change.
let r = 17;
const noise = () => (((r = (r * 16807) % 2147483647) / 2147483647) - 0.5) * 0.003;
function angledHand(id, lift = [0, 0, 0, 0, 0], cx = 0.4) {
  const lm = Array.from({ length: 21 }, () => ({ x: cx, y: 0.85, z: 0 }));
  lm[0] = { x: cx, y: 0.95, z: 0 };
  [2, 5, 9, 13, 17].forEach((b, f) => (lm[b] = { x: cx + (f - 2) * 0.04, y: 0.8, z: 0 }));
  [4, 8, 12, 16, 20].forEach((t, f) => {
    lm[t] = { x: cx + (f - 2) * 0.04 + 0.05 * lift[f] + noise(), y: 0.68 - 0.004 * lift[f] + noise(), z: -0.002 * lift[f] + noise() };
  });
  return { id, landmarks: lm };
}
const tapShape = (k) => (k < 4 ? k / 4 : k < 6 ? 1 - (k - 4) / 2 : 0); // 4 frames up, 2 frames down, then rest
function tapFrames(f, cx) {
  return Array.from({ length: 10 }, (_, k) => { const l = [0, 0, 0, 0, 0]; l[f] = tapShape(k); return [angledHand('R', l, cx)]; });
}
const layout = buildLayout({ startMidi: 60, whiteCount: 7, x: 0.1, y: 0.5, width: 0.7, height: 0.35 });
const run = (det, frames) => frames.flatMap((h, i) => det.update(h, layout, i / 30).events);

function calibrate() {
  const cal = createCalibrator();
  // ~8 s: every finger taps three times, with rests in between.
  for (let round = 0; round < 3; round++) for (let f = 1; f < 5; f++) {
    for (let k = 0; k < 8; k++) cal.add([angledHand('R')]);
    for (const fr of tapFrames(f)) cal.add(fr);
  }
  return cal.result();
}

test('calibration learns the tap direction and counts each finger’s taps', () => {
  const c = calibrate();
  assert.ok(c && c.hands.R, 'calibrated');
  // Sideways motion dominates the learned direction for this camera angle.
  assert.ok(Math.abs(c.hands.R.w[1]) > 0.8, `direction ${c.hands.R.w.map((v) => v.toFixed(2))}`);
  assert.deepEqual(c.hands.R.taps.slice(1), [3, 3, 3, 3]);
});

test('a tap that the uncalibrated detector misses registers after calibration', () => {
  const seq = [...Array.from({ length: 10 }, () => [angledHand('R')]), ...tapFrames(2), ...Array.from({ length: 5 }, () => [angledHand('R')])];
  const before = run(createDetector({ mode: 'surface' }), seq);
  assert.equal(before.filter((e) => e.type === 'on').length, 0);

  const det = createDetector({ mode: 'surface', calibration: calibrate() });
  const after = run(det, seq);
  const on = after.filter((e) => e.type === 'on');
  assert.equal(on.length, 1);
  assert.equal(on[0].finger, 'R:2');
});

test('after calibration, a resting hand with jitter plays nothing', () => {
  const det = createDetector({ mode: 'surface', calibration: calibrate() });
  assert.equal(run(det, Array.from({ length: 120 }, () => [angledHand('R')])).length, 0);
});

test('no taps during calibration (only jitter) gives no calibration', () => {
  const cal = createCalibrator();
  for (let i = 0; i < 240; i++) cal.add([angledHand('R')]);
  assert.equal(cal.result(), null);
});
