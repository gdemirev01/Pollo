import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoSizeStep, keyWidthAt } from '../src/autosize.js';
import { rectQuad } from '../src/layout-editor.js';
import { placement } from '../src/homography.js';

const hand = (cx, gap) => [[0, 1, 2, 3].map((i) => ({ x: cx + (i - 1.5) * gap, y: 0.5 }))];

test('keys too big for the fingers shrink to one finger gap, around the hand', () => {
  let quad = rectQuad({ x: 0.0, y: 0.3, w: 14 * 0.06, h: 0.4 }); // keys 0.06 wide
  const h = hand(0.4, 0.03); // fingers 0.03 apart
  const before = placement(quad).toLocal(0.4, 0.5);
  for (let i = 0; i < 120; i++) { const q = autoSizeStep(quad, 14, h, 1, { dt: 1 / 30 }); if (q) quad = q; }
  const { width } = keyWidthAt(quad, 14, 0.4, 0.5, 1);
  assert.ok(Math.abs(width / 0.03 - 1) < 0.11, `key width ${width.toFixed(4)}`);
  const after = placement(quad).toLocal(0.4, 0.5);
  assert.ok(Math.abs(after.x - before.x) < 1e-9, 'the key under the hand stays the same');
});

test('keys about the right size are left alone (no wobble)', () => {
  const quad = rectQuad({ x: 0.1, y: 0.3, w: 14 * 0.031, h: 0.3 });
  assert.equal(autoSizeStep(quad, 14, hand(0.3, 0.03), 1), null);
});

test('a hand far away from the keyboard does not resize it', () => {
  const quad = rectQuad({ x: 0.0, y: 0.6, w: 0.3, h: 0.2 });
  assert.equal(autoSizeStep(quad, 14, [[0, 1, 2, 3].map((i) => ({ x: 0.9 + i * 0.01, y: 0.05 }))], 1), null);
});

test('it settles smoothly, not in one jump', () => {
  const quad = rectQuad({ x: 0.0, y: 0.3, w: 14 * 0.06, h: 0.4 });
  const q = autoSizeStep(quad, 14, hand(0.4, 0.03), 1, { dt: 1 / 30, tau: 0.8 });
  const { width } = keyWidthAt(q, 14, 0.4, 0.5, 1);
  assert.ok(width < 0.06 && width > 0.055, `one step went to ${width.toFixed(4)}`);
});
