import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poseFromQuad, keyBoxes, keyboardSize, boxFaces } from '../src/ar.js';
import { buildLayout } from '../src/piano.js';

// A real camera looking down at the table at an angle, to compare against.
const W = 1280, H = 720, FOV = 65;
const f = W / 2 / Math.tan((FOV * Math.PI) / 360);
function camera(tiltDeg, dist) {
  const a = (tiltDeg * Math.PI) / 180;
  // Table axes seen from the camera: X right, Y toward the player (tilted), up toward the camera.
  const r1 = [1, 0, 0], r2 = [0, Math.cos(a), -Math.sin(a)], up = [0, -Math.sin(a), -Math.cos(a)];
  const t = [-16, -4, dist];
  return (X, Y, Z) => {
    const P = [0, 1, 2].map((i) => X * r1[i] + Y * r2[i] + Z * up[i] + t[i]);
    return { x: (f * P[0]) / P[2] + W / 2, y: (f * P[1]) / P[2] + H / 2 };
  };
}

test('pose from the keyboard corners reproduces where raised points appear', () => {
  const size = keyboardSize(14);
  for (const tilt of [20, 45, 70]) {
    const cam = camera(tilt, 45);
    const quad = [[0, 0], [size.w, 0], [size.w, size.d], [0, size.d]].map(([X, Y]) => { const p = cam(X, Y, 0); return [p.x, p.y]; });
    const pose = poseFromQuad(quad, W, H, FOV, size);
    assert.ok(pose, 'pose found');
    for (const [X, Y, Z] of [[5, 5, 3], [30, 12, 2], [16, 0, 4]]) {
      const a = pose.project(X, Y, Z), b = cam(X, Y, Z);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.5, `tilt ${tilt}: off by ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(2)} px`);
    }
  }
});

test('keys stand up toward the camera, also in a mirrored picture', () => {
  const size = keyboardSize(14);
  const cam = camera(45, 45);
  const quad = [[0, 0], [size.w, 0], [size.w, size.d], [0, size.d]].map(([X, Y]) => { const p = cam(X, Y, 0); return [p.x, p.y]; });
  const mirrored = [quad[1], quad[0], quad[3], quad[2]].map(([x, y]) => [W - x, y]); // flipped picture, corners still TL,TR,BR,BL
  for (const q of [quad, mirrored]) {
    const pose = poseFromQuad(q, W, H, FOV, size);
    const base = pose.project(10, 10, 0), raised = pose.project(10, 10, 3);
    assert.ok(raised.depth < base.depth, 'raised point is closer to the camera');
  }
});

test('a key seen from the front-above shows its top and front, not its back', () => {
  const size = keyboardSize(14);
  const cam = camera(45, 45);
  const quad = [[0, 0], [size.w, 0], [size.w, size.d], [0, size.d]].map(([X, Y]) => { const p = cam(X, Y, 0); return [p.x, p.y]; });
  const pose = poseFromQuad(quad, W, H, FOV, size);
  const names = boxFaces(pose, 10, 12, 0, 15, 0, 1.6).map((fc) => fc.name);
  assert.ok(names.includes('top') && names.includes('front'));
  assert.ok(!names.includes('back'));
});

test('pressed keys sink and black keys are drawn after white keys', () => {
  const size = keyboardSize(7);
  const cam = camera(45, 40);
  const quad = [[0, 0], [size.w, 0], [size.w, size.d], [0, size.d]].map(([X, Y]) => { const p = cam(X, Y, 0); return [p.x, p.y]; });
  const pose = poseFromQuad(quad, W, H, FOV, size);
  const layout = buildLayout({ startMidi: 60, whiteCount: 7, x: 0, y: 0, width: 1, height: 1 });
  const boxes = keyBoxes(pose, layout, size, new Set([62]));
  const firstBlack = boxes.findIndex((b) => b.key.black);
  assert.ok(boxes.slice(firstBlack).every((b) => b.key.black));
  const d = boxes.find((b) => b.key.midi === 62), e = boxes.find((b) => b.key.midi === 64);
  assert.ok(d.down && !e.down);
});
