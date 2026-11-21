import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout, hitTest, keyAtX, isBlack, noteName } from '../src/piano.js';

test('two octaves from C4 has 14 white and 10 black keys', () => {
  const { keys } = buildLayout({ startMidi: 60, whiteCount: 14 });
  assert.equal(keys.filter((k) => !k.black).length, 14);
  assert.equal(keys.filter((k) => k.black).length, 10);
  assert.equal(keys[0].name, 'C4');
  assert.equal(keys.at(-1).name, 'B5');
});

test('start on a black key snaps down to a white key', () => {
  const { keys } = buildLayout({ startMidi: 61, whiteCount: 7 });
  assert.equal(keys[0].midi, 60);
});

test('noteName / isBlack', () => {
  assert.equal(noteName(69), 'A4');
  assert.ok(isBlack(61));
  assert.ok(!isBlack(64));
});

test('hitTest prefers black keys and handles misses', () => {
  const L = buildLayout({ startMidi: 60, whiteCount: 7, x: 0, y: 0.5, width: 0.7, height: 0.4 });
  // Boundary between C and D (x = 0.1), upper band -> C#
  assert.equal(hitTest(L, 0.1, 0.55).name, 'C#4');
  // Same x, lower band -> white key D (x just right of the boundary)
  assert.equal(hitTest(L, 0.101, 0.85).name, 'D4');
  assert.equal(hitTest(L, 0.05, 0.85).name, 'C4');
  assert.equal(hitTest(L, 0.05, 0.3), null); // above keyboard
  assert.equal(hitTest(L, 0.8, 0.7), null); // right of keyboard
});

test('keyAtX ignores height except for black-key band', () => {
  const L = buildLayout({ startMidi: 60, whiteCount: 7, x: 0, y: 0.5, width: 0.7, height: 0.4 });
  assert.equal(keyAtX(L, 0.05, 0.1).name, 'C4');
  assert.equal(keyAtX(L, 0.1, 0.1).name, 'C#4');
  assert.equal(keyAtX(L, 0.1, 0.85).name, 'D4');
});
