import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneEuro } from '../src/filters.js';

let r = 3;
const noise = () => (((r = (r * 16807) % 2147483647) / 2147483647) - 0.5) * 0.01;

test('one euro: much less jitter at rest', () => {
  const f = new OneEuro();
  const raw = [], out = [];
  for (let i = 0; i < 120; i++) { const v = 0.5 + noise(); raw.push(v); out.push(f.filter(v, i / 30)); }
  const sd = (a) => { const s = a.slice(30); const m = s.reduce((x, y) => x + y) / s.length; return Math.sqrt(s.reduce((x, y) => x + (y - m) ** 2, 0) / s.length); };
  assert.ok(sd(out) < sd(raw) * 0.4, `${sd(out)} vs ${sd(raw)}`);
});

test('one euro: follows a fast tap with little lag', () => {
  const f = new OneEuro();
  for (let i = 0; i < 30; i++) f.filter(0.5, i / 30);
  // finger drops 0.08 within 3 frames (~100 ms)
  let v;
  [0.53, 0.56, 0.58, 0.58, 0.58].forEach((x, i) => (v = f.filter(x, (30 + i) / 30)));
  assert.ok(v > 0.565, `only reached ${v}`);
});
