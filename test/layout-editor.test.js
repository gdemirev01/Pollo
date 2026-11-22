import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grabAt, dragRect, MIN_W, MIN_H } from '../src/layout-editor.js';

const r = { x: 0.2, y: 0.5, w: 0.6, h: 0.3 };
const tol = { x: 0.02, y: 0.02 };
const near = (a, b) => Object.keys(b).forEach((k) => assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${k}: ${a[k]} vs ${b[k]}`));

test('grabAt finds move, edges, corners and misses', () => {
  assert.equal(grabAt(r, 0.5, 0.65, tol), 'move');
  assert.equal(grabAt(r, 0.2, 0.5, tol), 'nw');
  assert.equal(grabAt(r, 0.81, 0.79, tol), 'se');
  assert.equal(grabAt(r, 0.5, 0.505, tol), 'n');
  assert.equal(grabAt(r, 0.795, 0.65, tol), 'e');
  assert.equal(grabAt(r, 0.5, 0.3, tol), null);
  assert.equal(grabAt(r, 0.1, 0.65, tol), null);
});

test('move is clamped to the screen', () => {
  near(dragRect(r, 'move', 0.1, -0.1), { x: 0.3, y: 0.4, w: 0.6, h: 0.3 });
  near(dragRect(r, 'move', 0.5, 0.5), { x: 0.4, y: 0.7, w: 0.6, h: 0.3 });
});

test('resizing from corners and edges', () => {
  near(dragRect(r, 'se', 0.1, 0.1), { x: 0.2, y: 0.5, w: 0.7, h: 0.4 });
  near(dragRect(r, 'nw', -0.1, -0.1), { x: 0.1, y: 0.4, w: 0.7, h: 0.4 });
  near(dragRect(r, 'w', 0.1, 0), { x: 0.3, y: 0.5, w: 0.5, h: 0.3 });
});

test('resizing respects minimum size and screen edges', () => {
  const a = dragRect(r, 'e', -1, 0);
  assert.ok(Math.abs(a.w - MIN_W) < 1e-9);
  const b = dragRect(r, 'n', 0, 1);
  assert.ok(Math.abs(b.h - MIN_H) < 1e-9);
  assert.ok(Math.abs(b.y + b.h - 0.8) < 1e-9); // bottom edge stays put
  const c = dragRect(r, 'se', 1, 1);
  near(c, { x: 0.2, y: 0.5, w: 0.8, h: 0.5 });
});
