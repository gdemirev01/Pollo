import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placement } from '../src/homography.js';
import { grabAt, dragQuad, isValidQuad, rectQuad } from '../src/layout-editor.js';
import { snapQuad, createSteadiness } from '../src/snap.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('homography maps unit square corners to the quad and back', () => {
  const q = [[0.1, 0.5], [0.9, 0.45], [0.95, 0.9], [0.05, 0.95]];
  const P = placement(q);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const s = P.toScreen(u, v);
    close(s.x, q[i][0]); close(s.y, q[i][1]);
  });
  const mid = P.toScreen(0.3, 0.7);
  const back = P.toLocal(mid.x, mid.y);
  close(back.x, 0.3); close(back.y, 0.7);
});

test('homography of a rectangle is plain scaling', () => {
  const P = placement(rectQuad({ x: 0.2, y: 0.5, w: 0.6, h: 0.4 }));
  const p = P.toLocal(0.5, 0.6);
  close(p.x, 0.5); close(p.y, 0.25);
});

test('quad editing: grab corners, edges, inside', () => {
  const q = rectQuad({ x: 0.2, y: 0.5, w: 0.6, h: 0.3 });
  const tol = { x: 0.02, y: 0.02 };
  assert.equal(grabAt(q, 0.2, 0.5, tol), 'c0');
  assert.equal(grabAt(q, 0.8, 0.8, tol), 'c2');
  assert.equal(grabAt(q, 0.5, 0.505, tol), 'e0');
  assert.equal(grabAt(q, 0.799, 0.65, tol), 'e1');
  assert.equal(grabAt(q, 0.5, 0.65, tol), 'move');
  assert.equal(grabAt(q, 0.5, 0.2, tol), null);
});

test('quad editing: corner drag makes a perspective quad; invalid shapes are refused', () => {
  const q = rectQuad({ x: 0.2, y: 0.5, w: 0.6, h: 0.3 });
  const t = dragQuad(q, 'c0', 0.1, 0);
  assert.deepEqual(t[0].map((v) => +v.toFixed(3)), [0.3, 0.5]);
  assert.ok(isValidQuad(t));
  assert.equal(dragQuad(q, 'c0', 0.7, 0.35), null); // drags past the opposite corner
});

test('quad editing: edge drag resizes along its normal, move stays on screen', () => {
  const q = rectQuad({ x: 0.2, y: 0.5, w: 0.6, h: 0.3 });
  const r = dragQuad(q, 'e1', 0.1, 0.05); // right edge: only x changes
  close(r[1][0], 0.9); close(r[2][0], 0.9); close(r[1][1], 0.5); close(r[2][1], 0.8);
  const m = dragQuad(q, 'move', 0.5, 0.5);
  close(Math.max(...m.map((p) => p[0])), 1); close(Math.max(...m.map((p) => p[1])), 1);
});

test('snap: fingertips in a row put the keyboard under them, tips on the near half', () => {
  const tips = [0.3, 0.4, 0.5, 0.6, 0.7].map((x) => ({ x, y: 0.5 }));
  const wrists = [{ x: 0.35, y: 0.75 }, { x: 0.65, y: 0.75 }];
  const q = snapQuad(tips, wrists, 1);
  assert.ok(isValidQuad(q));
  const P = placement(q);
  const t = P.toLocal(0.3, 0.5), t2 = P.toLocal(0.7, 0.5);
  close(t.y, 0.72, 1e-3);
  assert.ok(t.x > 0.05 && t2.x < 0.95 && t.x < t2.x);
});

test('snap: tilted hands give a tilted keyboard', () => {
  const tips = [0.3, 0.4, 0.5, 0.6, 0.7].map((x) => ({ x, y: 0.5 + (x - 0.5) * 0.3 }));
  const q = snapQuad(tips, [{ x: 0.5, y: 0.8 }], 1);
  assert.ok(q[1][1] > q[0][1] + 0.05); // right end lower, following the hands
});

test('snap: player at the top of the picture turns the keyboard round', () => {
  const tips = [0.3, 0.4, 0.5, 0.6, 0.7].map((x) => ({ x, y: 0.5 }));
  const q = snapQuad(tips, [{ x: 0.5, y: 0.2 }], 1);
  assert.ok(isValidQuad(q));
  const P = placement(q);
  assert.ok(P.toLocal(0.3, 0.5).x > P.toLocal(0.7, 0.5).x); // low notes on screen right = player's left
});

test('snap: very wide or tilted hands still give a keyboard fully on screen', () => {
  const tips = [0.02, 0.3, 0.6, 0.98].map((x, i) => ({ x, y: 0.2 + i * 0.2 }));
  const q = snapQuad(tips, [{ x: 0.3, y: 0.9 }], 16 / 9);
  assert.ok(isValidQuad(q));
  for (const [x, y] of q) assert.ok(x >= -1e-9 && x <= 1 + 1e-9 && y >= -1e-9 && y <= 1 + 1e-9, `${x},${y}`);
});

test('snap upright (front camera): wrists above the fingertips keep the keyboard upright', () => {
  const tips = [0.3, 0.4, 0.5, 0.6, 0.7].map((x) => ({ x, y: 0.6 }));
  const q = snapQuad(tips, [{ x: 0.5, y: 0.3 }], 16 / 9, { orient: 'upright' });
  assert.ok(isValidQuad(q));
  assert.ok(q[0][1] < q[3][1]); // black-key end at the top
  const P = placement(q);
  assert.ok(P.toLocal(0.3, 0.6).x < P.toLocal(0.7, 0.6).x); // low notes on the left
  close(P.toLocal(0.5, 0.6).y, 0.72, 1e-3);
});

test('steadiness: progress builds while still and resets on movement', () => {
  const s = createSteadiness({ hold: 1, maxMove: 0.02 });
  const tips = { a: { x: 0.5, y: 0.5 } };
  assert.equal(s.add(0, tips), 0);
  close(s.add(0.5, { a: { x: 0.505, y: 0.5 } }), 0.5);
  assert.equal(s.add(0.6, { a: { x: 0.6, y: 0.5 } }), 0);
  assert.equal(s.add(1.7, { a: { x: 0.6, y: 0.5 } }), 1);
});
