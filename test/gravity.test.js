import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceRotation, cameraToWorld, intrinsics, rayToTable, project, worldFromQuad, quadFromWorld, snapToTable } from '../src/gravity.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg ?? ''} ${a} vs ${b}`);
const K = intrinsics(720, 1280, 65); // portrait picture

test('phone lying flat, screen up: down is out of its back', () => {
  const R = deviceRotation(0, 0, 0);
  // device -> world; the device's -z (out of the back) should map to world down.
  const down = [R[2] * -1, R[5] * -1, R[8] * -1];
  assert.deepEqual(down.map((v) => Math.round(v) + 0), [0, 0, -1]);
  // Back camera held flat over the table: the picture centre looks straight down.
  const Rcw = cameraToWorld(0, 0, 0, 'environment');
  const P = rayToTable(K, Rcw, K.cx, K.cy);
  close(P[0], 0, 1e-9); close(P[1], 0, 1e-9); close(P[2], -1, 1e-9);
});

test('screen corners -> table -> screen round trip', () => {
  const Rcw = cameraToWorld(10, 40, -8, 'environment');
  const quad = [[200, 500], [520, 520], [600, 900], [120, 880]];
  const W = worldFromQuad(K, Rcw, quad);
  assert.ok(W);
  for (const P of W) close(P[2], -1, 1e-9, 'on the table');
  const back = quadFromWorld(K, Rcw, W);
  back.forEach(([x, y], i) => { close(x, quad[i][0], 1e-6); close(y, quad[i][1], 1e-6); });
});

test('turning the phone about vertical turns the keyboard in the picture by the same angle', () => {
  const R1 = cameraToWorld(0, 0, 0, 'environment');
  const W = worldFromQuad(K, R1, [[160, 500], [560, 500], [560, 800], [160, 800]]);
  const R2 = cameraToWorld(20, 0, 0, 'environment');
  const q = quadFromWorld(K, R2, W);
  const ang = (Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180) / Math.PI;
  close(Math.abs(ang), 20, 1e-6, 'turned');
});

test('tilting the phone keeps the keyboard on the same spot of the table', () => {
  const R1 = cameraToWorld(0, 30, 0, 'environment');
  const W = worldFromQuad(K, R1, [[200, 600], [520, 600], [560, 900], [160, 900]]);
  const R2 = cameraToWorld(0, 40, 5, 'environment');
  const q = quadFromWorld(K, R2, W);
  const W2 = worldFromQuad(K, R2, q);
  W.forEach((P, i) => P.forEach((v, j) => close(v, W2[i][j], 1e-9)));
});

// A hand resting on the table, described on the table and projected into the picture.
function handOnTable(Rcw, cx, cy, gap, dir = 1) {
  const px = (X, Y) => { const p = project(K, Rcw, [X, Y, -1]); return { x: p.x, y: p.y }; };
  return {
    tips: [0, 1, 2, 3].map((i) => px(cx + dir * (i - 1.5) * gap, cy + 0.02 * Math.abs(i - 1.5))),
    knuckles: [px(cx - dir * 1.5 * gap * 0.9, cy - 0.15), px(cx + dir * 1.5 * gap * 0.9, cy - 0.15)],
    wrist: px(cx, cy - 0.4),
  };
}

test('snap puts the keyboard flat on the table under the fingertips, one finger gap per key', () => {
  const Rcw = cameraToWorld(0, 35, 0, 'environment'); // phone tilted over the table
  const hand = handOnTable(Rcw, 0.1, 0.9, 0.06);
  const r = snapToTable(K, Rcw, [hand], 14);
  assert.ok(r);
  const [c0, c1, c2, c3] = r.corners;
  for (const P of r.corners) close(P[2], -1, 1e-9, 'on the table');
  // The fingertips arch slightly, so neighbouring gaps are a little over 0.06 (median of 0.060, 0.063, 0.063).
  close(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) / 14, Math.hypot(0.06, 0.02), 1e-6, 'key width');
  // Keys run across the hand (world x here), low notes on the player's left.
  close(Math.abs(c1[0] - c0[0]) / Math.hypot(c1[0] - c0[0], c1[1] - c0[1]), 1, 1e-6, 'lined up');
  // Player (wrist side) is toward -y here, so the near edge (c2, c3) is at lower y than the far edge.
  assert.ok(c3[1] < c0[1], 'near edge toward the player');
  // Seen from the player (facing +y), their left is -x: low notes there.
  assert.ok(c0[0] < c1[0], 'low notes on the left');
});

test('snap with the front camera held upright gives a keyboard in true perspective, not a flat rectangle', () => {
  const Rcw = cameraToWorld(0, 75, 0, 'user'); // phone almost upright, front camera facing the player
  // Hands on the table in front of the phone (forward from the camera = world -y for the front camera).
  const r = snapToTable(K, Rcw, [handOnTable(Rcw, 0, -2.5, 0.12, -1)], 14);
  assert.ok(r);
  const q = quadFromWorld(K, Rcw, r.corners);
  const far = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), near = Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]);
  // The edge away from the player is the one closest to the phone, so it looks wider.
  assert.ok(far > near * 1.1, `far ${far.toFixed(0)} px vs near ${near.toFixed(0)} px`);
});
