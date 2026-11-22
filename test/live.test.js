import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSession } from '../src/live.js';

test('live session batches rows and posts them insert-only to the table', async () => {
  const calls = [];
  let clock = 0;
  const live = createLiveSession({ url: 'https://x.supabase.co', key: 'pk', table: 'pollo_events' }, {
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true }; },
    now: () => clock,
  });
  assert.ok(live.configured);
  const code = live.start({ build: 12 });
  assert.match(code, /^[A-Z2-9]{4}$/);
  const hand = { id: 'R', landmarks: Array.from({ length: 21 }, (_, i) => ({ x: i / 21, y: 0.5, z: 0.0012345 })) };
  clock = 50; live.frame(50, { hands: [hand], fingers: [], fps: 24.6 });
  clock = 80; live.frame(80, { hands: [hand], fingers: [], fps: 24 }); // too soon: dropped (max 10/s)
  clock = 200; live.frame(200, { hands: [hand], fingers: [], fps: 24 });
  live.note({ type: 'on', midi: 64, finger: 'R:1', velocity: 0.6789 });
  await live.stop({});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://x.supabase.co/rest/v1/pollo_events');
  assert.equal(calls[0].opts.headers.apikey, 'pk');
  assert.equal(calls[0].opts.headers.Prefer, 'return=minimal');
  const rows = JSON.parse(calls[0].opts.body);
  assert.deepEqual(rows.map((r) => r.kind), ['info', 'frame', 'frame', 'note', 'info']);
  assert.ok(rows.every((r) => r.session === code));
  assert.equal(rows[1].data.hands[0].lm[0][2], 0.001); // rounded
  assert.equal(rows[3].data.velocity, 0.68);
  assert.equal(live.stats.sent, 5);
});

test('without a database configured, nothing is sent', async () => {
  const live = createLiveSession({ url: null, key: null, table: 't' }, { fetchImpl: () => { throw new Error('should not send'); } });
  assert.equal(live.configured, false);
});
