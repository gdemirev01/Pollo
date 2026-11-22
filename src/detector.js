// Turns hand landmarks into note on/off events. Pure logic: no DOM, no audio.
//
// Ways to play:
//  - tap:     tap the table, camera in front of you.
//  - surface: tap the table, camera above looking down.
//  - zone:    any fingertip that enters a key plays it.
//
// Both tap modes use the same strike detector. Each finger has a height above
// the table, measured against its own knuckle so moving the whole hand doesn't
// count:
//  - camera in front: how far the fingertip is above its knuckle in the picture
//  - camera above:    how close the fingertip is to the camera (depth), plus how
//                     much shorter the finger looks from above when lifted
// Each finger learns its own table level (the lowest it rests at). A note plays
// when a finger that was lifted comes down fast and stops at the table, on the
// key under the fingertip. It's released when the finger lifts off again. When
// one finger strikes, neighbours that only twitched along with it are ignored.
import { hitTest } from './piano.js';
import { featuresOf, calibratedHeight, calibratedRest } from './calibrate.js';

export const FINGERTIPS = [4, 8, 12, 16, 20];
export const FINGER_BASES = [2, 5, 9, 13, 17]; // knuckle each finger is measured from
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const WRIST = 0, MIDDLE_MCP = 9;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const STRIKE_DEFAULTS = {
  tap: { travel: 0.14, contact: 0.05, release: 0.1, speed: 0.9 },
  surface: { travel: 0.1, contact: 0.04, release: 0.07, speed: 0.6 },
  // After calibration heights are in "typical taps": 0 resting, about 1 at the top.
  calibrated: { travel: 0.4, contact: 0.15, release: 0.28, speed: 2.2 },
};

export function createDetector(opts = {}) {
  const cfg = {
    mode: 'tap',
    scale: 1, // sensitivity: < 1 needs smaller, slower taps; > 1 needs bigger, faster ones
    depthWeight: 1,
    lengthWeight: 1.2,
    zoneMargin: 0.015,
    useThumb: false,
    chordRatio: 0.8, // a finger striking with < this fraction of the strongest finger's speed is a twitch
    calibration: null, // from calibrate.js, for the current mode
    relative: true, // measure each finger against the hand's other fingers
    ...opts,
  };
  const fingers = new Map(); // fingerId -> state

  function strikeCfg() {
    const d = cfg.calibration ? STRIKE_DEFAULTS.calibrated : STRIKE_DEFAULTS[cfg.mode] || STRIKE_DEFAULTS.tap;
    const k = cfg.scale;
    return { travel: d.travel * k, contact: d.contact, release: d.contact + (d.release - d.contact) * k, speed: d.speed * k };
  }

  /** Raw height of a finger above the table (bigger = lifted), before subtracting the table level. */
  function rawHeight(lm, f, size, handId) {
    if (cfg.calibration) return calibratedHeight(cfg.calibration, handId, lm, f, size);
    const [up, , depth, length] = featuresOf(lm, f, size);
    if (cfg.mode === 'surface') return cfg.depthWeight * depth + cfg.lengthWeight * length;
    return up;
  }

  /**
   * @param hands Array<{ id, landmarks: Array<{x, y, z?}> }> in display coordinates
   * @param layout keyboard layout
   * @param t time in seconds
   * @param toLocal maps a screen point into the layout's coordinates
   */
  function update(hands, layout, t, toLocal = (x, y) => ({ x, y })) {
    const events = [];
    const seen = new Set();
    const S = strikeCfg();

    for (const hand of hands) {
      const lm = hand.landmarks;
      const size = Math.max(1e-3, dist(lm[WRIST], lm[MIDDLE_MCP]));
      const candidates = [];
      const pending = []; // fingers measured this frame, for the strike checks below

      FINGERTIPS.forEach((tipIdx, f) => {
        const id = `${hand.id}:${f}`;
        seen.add(id);
        const tip = lm[tipIdx];
        let st = fingers.get(id);
        if (!st) {
          st = { key: null, sx: tip.x, sy: tip.y, signal: 0, state: 'idle', hist: [], table: null, down: false, quietUntil: 0 };
          fingers.set(id, st);
        }
        st.sx = tip.x;
        st.sy = tip.y;

        if (f === 0 && !cfg.useThumb && cfg.mode !== 'zone') {
          if (st.key) { events.push({ type: 'off', midi: st.key.midi, finger: id }); st.key = null; }
          st.state = 'off'; st.signal = 0; st.down = false;
          return;
        }

        if (cfg.mode === 'zone') {
          const top = layout.bounds.y;
          const margin = st.key ? -cfg.zoneMargin : cfg.zoneMargin;
          const l = toLocal(tip.x, tip.y);
          const target = l.y >= top + margin ? hitTest(layout, l.x, Math.max(l.y, top + 1e-6)) : null;
          if (target?.midi !== st.key?.midi) {
            if (st.key) events.push({ type: 'off', midi: st.key.midi, finger: id });
            if (target) events.push({ type: 'on', midi: target.midi, velocity: 0.75, finger: id });
            st.key = target || null;
          }
          st.signal = target ? 1 : 0;
          st.state = st.key ? 'pressed' : 'idle';
          return;
        }

        // Height above this finger's table level: the low end of its last few seconds
        // (ignoring the lowest 10%, so one glitchy frame can't drag it down), and
        // after calibration never above where the finger rested.
        const raw = rawHeight(lm, f, size, hand.id);
        (st.raws ||= []).push({ t, v: raw });
        while (st.raws.length && t - st.raws[0].t > 4) st.raws.shift();
        const sorted = st.raws.map((r) => r.v).sort((a, b) => a - b);
        let table = sorted[Math.floor((sorted.length - 1) * 0.1)];
        const rest = cfg.calibration ? calibratedRest(cfg.calibration, hand.id, f) : null;
        if (rest !== null) table = Math.min(table, rest + 0.25);
        st.table = table;
        st.hAbs = Math.max(0, raw - table);
        pending.push({ id, st, f });
      });

      // A tap is one finger moving on its own: subtract what the hand's other fingers
      // are doing (their middle value), so the whole hand rising, settling or shifting
      // (which changes every finger's reading together) doesn't count. Two fingers
      // tapping together still work: the others stay at rest.
      for (const { id, st, f } of pending) {
        const others = pending.filter((o) => o.f !== f && o.f !== 0).map((o) => o.st.hAbs).sort((a, b) => a - b);
        const common = cfg.relative && others.length >= 2 ? others[Math.floor((others.length - 1) / 2)] : 0;
        const h = Math.max(0, st.hAbs - common);
        st.signal = h;
        st.hist.push({ t, h });
        while (st.hist.length && t - st.hist[0].t > 0.4) st.hist.shift();

        let peak = 0, speed = 0, liftedFrames = 0;
        for (let i = 0; i < st.hist.length; i++) {
          peak = Math.max(peak, st.hist[i].h);
          if (st.hist[i].h >= S.travel) liftedFrames++;
          if (i && t - st.hist[i].t <= 0.15) {
            const a = st.hist[i - 1], b = st.hist[i];
            speed = Math.max(speed, (a.h - b.h) / Math.max(1e-3, b.t - a.t)); // downward = positive
          }
        }

        if (st.down) {
          if (h > S.release) {
            st.down = false;
            if (st.key) events.push({ type: 'off', midi: st.key.midi, finger: id });
            st.key = null;
          }
        } else if (h <= S.contact && liftedFrames >= 2 && speed >= S.speed && t >= st.quietUntil) {
          candidates.push({ id, st, speed });
        }
        st.state = st.down ? 'pressed' : peak >= S.travel ? 'armed' : 'idle';
      }

      // Strikes this frame: keep the real ones, drop fingers that only twitched along.
      const strongest = Math.max(0, ...candidates.map((c) => c.speed));
      for (const c of candidates) {
        const { st, id } = c;
        st.hist.length = 0; // a strike uses up its lift
        if (c.speed < strongest * cfg.chordRatio) { st.quietUntil = t + 0.12; continue; }
        st.down = true;
        st.state = 'pressed';
        const l = toLocal(st.sx, st.sy);
        const key = hitTest(layout, l.x, l.y);
        if (key) {
          st.key = key;
          const v = c.speed / (S.speed / STRIKE_DEFAULTS.tap.speed); // comparable loudness with or without calibration
          events.push({ type: 'on', midi: key.midi, velocity: Math.max(0.35, Math.min(1, 0.35 + v / 8)), finger: id });
        }
      }
    }

    for (const [id, st] of fingers) {
      if (!seen.has(id)) {
        if (st.key) events.push({ type: 'off', midi: st.key.midi, finger: id });
        fingers.delete(id);
      }
    }

    const active = new Map();
    for (const [id, st] of fingers) if (st.key) active.set(id, st.key);
    return { events, active };
  }

  /** Thresholds for drawing meters: { on, off } in signal units. */
  function thresholds() {
    if (cfg.mode === 'zone') return { on: 0.5, off: 0.5, label: 'in key' };
    const S = strikeCfg();
    return { on: S.travel, off: S.contact, label: 'height' };
  }

  function setOptions(o) { Object.assign(cfg, o); }
  function reset() {
    const events = [];
    for (const [id, st] of fingers) if (st.key) events.push({ type: 'off', midi: st.key.midi, finger: id });
    fingers.clear();
    return events;
  }
  const smoothed = (id) => fingers.get(id);

  return { update, setOptions, reset, smoothed, thresholds, config: cfg };
}
