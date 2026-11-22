// Live session: while it's on, the app sends what it sees (as numbers, never
// video) to a database, so the session can be watched and analysed while you play.
// Rows can only be added with the app's public key, never read back through it.
//
// Each row: { session, t (seconds since start), kind, data }.
//   kind 'frame': hands (21 points each, rounded), finger heights and states, fps
//   kind 'note' : a note on/off with finger and velocity
//   kind 'info' : mode, calibration, keyboard position, device, build, and changes

export const LIVE_CONFIG = {
  url: null, // e.g. https://<project>.supabase.co
  key: null, // the project's publishable key (safe to ship: insert-only by policy)
  table: 'pollo_events',
};

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

export function createLiveSession(config = LIVE_CONFIG, { fetchImpl = (...a) => fetch(...a), now = () => performance.now() } = {}) {
  let session = null, t0 = 0, queue = [], timer = null, sent = 0, failed = 0, lastFrame = -1e9, lastError = '';

  const code = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  const push = (kind, data) => { if (session) queue.push({ session, t: round((now() - t0) / 1000), kind, data }); };

  async function flush() {
    if (!queue.length || !config.url) return;
    const rows = queue.splice(0, 500);
    try {
      const r = await fetchImpl(`${config.url}/rest/v1/${config.table}`, {
        method: 'POST',
        headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(rows),
        keepalive: true,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      sent += rows.length;
    } catch (e) {
      failed += rows.length;
      lastError = e.message || String(e);
    }
  }

  return {
    get configured() { return !!(config.url && config.key); },
    get active() { return !!session; },
    get code() { return session; },
    get stats() { return { sent, failed, queued: queue.length, lastError }; },
    start(info) {
      session = code(); t0 = now(); sent = failed = 0; queue = []; lastFrame = -1e9; lastError = '';
      push('info', { event: 'start', ...info });
      timer = setInterval(flush, 1000);
      return session;
    },
    async stop(info) {
      push('info', { event: 'stop', ...info });
      clearInterval(timer); timer = null;
      await flush();
      const s = session; session = null;
      return s;
    },
    info(data) { push('info', data); },
    note(e) { push('note', { type: e.type, midi: e.midi, finger: e.finger, velocity: e.velocity != null ? round(e.velocity, 2) : undefined }); },
    /** At most 10 frames a second. */
    frame(t, { hands, fingers, fps }) {
      if (!session || t - lastFrame < 100) return;
      lastFrame = t;
      push('frame', {
        fps: Math.round(fps),
        hands: hands.map((h) => ({ id: h.id, lm: h.landmarks.map((p) => [round(p.x), round(p.y), round(p.z ?? 0)]) })),
        fingers,
      });
    },
    flush,
  };
}
