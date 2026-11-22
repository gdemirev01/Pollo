// Turns hand landmarks into note on/off events. Pure logic: no DOM, no audio.
//
// Three ways to play:
//  - tap:     camera in front. A finger pushed down below the others (in the
//             picture) strikes the key under it.
//  - zone:    any fingertip that enters a key plays it.
//  - surface: camera above, looking down at hands on a table. Lift a finger and
//             tap it back down; the note plays when it lands. A lift is seen as
//             the fingertip coming closer to the camera (depth) and the finger
//             looking shorter from above. Each finger learns its own "on the
//             table" level, so resting fingers stay silent.
import { hitTest, keyAtX } from './piano.js';

export const FINGERTIPS = [4, 8, 12, 16, 20];
export const FINGER_BASES = [2, 5, 9, 13, 17]; // knuckle each finger's length is measured from
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const WRIST = 0, MIDDLE_MCP = 9;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function createDetector(opts = {}) {
  const cfg = {
    mode: 'tap',
    // tap mode: finger drop relative to hand size
    pressThreshold: 0.28,
    releaseThreshold: 0.16,
    // surface mode: lift score (hand-size units) to arm, and to count as landed
    liftThreshold: 0.17,
    landThreshold: 0.07,
    depthWeight: 1,
    lengthWeight: 1.5,
    // zone mode: hysteresis on the keyboard's top edge
    zoneMargin: 0.015,
    useThumb: false,
    smoothing: 0.5,
    ...opts,
  };
  /** fingerId -> per-finger state */
  const fingers = new Map();

  const velocityFrom = (speed) => Math.max(0.35, Math.min(1, 0.35 + speed / 6));

  /**
   * @param hands Array<{ id, landmarks: Array<{x, y, z?}> }> in display coordinates
   * @param layout keyboard layout from buildLayout
   * @param t time in seconds
   * @param toLocal maps a screen point into the layout's coordinates (for a
   *   keyboard placed in perspective); identity when the layout is on screen
   */
  function update(hands, layout, t, toLocal = (x, y) => ({ x, y })) {
    const events = [];
    const seen = new Set();

    for (const hand of hands) {
      const lm = hand.landmarks;
      const size = Math.max(1e-3, dist(lm[WRIST], lm[MIDDLE_MCP]));
      const tips = FINGERTIPS.map((i) => lm[i]);

      FINGERTIPS.forEach((tipIdx, f) => {
        const id = `${hand.id}:${f}`;
        seen.add(id);
        const raw = lm[tipIdx];
        let st = fingers.get(id);
        if (!st) {
          st = { key: null, sx: raw.x, sy: raw.y, sz: raw.z ?? 0, py: raw.y, pt: t, signal: 0, prevSignal: 0, armed: false, state: 'idle' };
          fingers.set(id, st);
        }
        const a = cfg.smoothing;
        st.sx = a * st.sx + (1 - a) * raw.x;
        st.sy = a * st.sy + (1 - a) * raw.y;
        st.sz = a * st.sz + (1 - a) * (raw.z ?? 0);
        const dt = Math.max(1e-3, t - st.pt);
        const speed = (st.sy - st.py) / dt / size; // + is downward in the picture
        st.py = st.sy;
        st.pt = t;

        const thumbOff = f === 0 && !cfg.useThumb && cfg.mode !== 'zone';
        let target = st.key;
        let velocity = velocityFrom(Math.max(0, speed));

        if (thumbOff) {
          target = null;
          st.signal = 0;
          st.armed = false;
        } else if (cfg.mode === 'zone') {
          const top = layout.bounds.y;
          const margin = st.key ? -cfg.zoneMargin : cfg.zoneMargin;
          const l = toLocal(st.sx, st.sy);
          target = l.y >= top + margin ? hitTest(layout, l.x, Math.max(l.y, top + 1e-6)) : null;
          st.signal = target ? 1 : 0;
        } else if (cfg.mode === 'surface') {
          // Lift score from two cues, each against this finger's learned table level.
          const len = dist(lm[FINGER_BASES[f]], { x: st.sx, y: st.sy }) / size;
          const z = st.sz / size;
          if (st.len0 === undefined) { st.len0 = len; st.z0 = z; }
          // Table level follows quickly toward "flat and far" and drifts back slowly.
          st.len0 += (len > st.len0 ? 0.3 : 0.004) * (len - st.len0);
          st.z0 += (z > st.z0 ? 0.3 : 0.004) * (z - st.z0);
          const depthLift = Math.max(0, st.z0 - z);
          const shortening = Math.max(0, 1 - len / Math.max(1e-3, st.len0));
          st.prevSignal = st.signal;
          st.signal = cfg.depthWeight * depthLift + cfg.lengthWeight * shortening;

          if (st.signal > cfg.liftThreshold) {
            st.armed = true;
            target = null; // lifting a finger lets go of its note
          } else if (st.armed && st.signal < cfg.landThreshold) {
            st.armed = false;
            const l = toLocal(st.sx, st.sy);
            target = hitTest(layout, l.x, l.y);
            const landSpeed = Math.max(0, st.prevSignal - st.signal) / dt;
            velocity = Math.max(0.35, Math.min(1, 0.35 + landSpeed / 4));
          }
        } else {
          // tap: how far this tip is below the other (non-thumb) fingertips.
          const others = tips.filter((_, j) => j !== f && j !== 0);
          const ref = others.reduce((s, p) => s + p.y, 0) / others.length;
          st.signal = (st.sy - ref) / size;
          if (!st.key && st.signal > cfg.pressThreshold) { const l = toLocal(st.sx, st.sy); target = keyAtX(layout, l.x, l.y); }
          else if (st.key && st.signal < cfg.releaseThreshold) target = null;
        }

        if (target?.midi !== st.key?.midi) {
          if (st.key) events.push({ type: 'off', midi: st.key.midi, finger: id });
          if (target) events.push({ type: 'on', midi: target.midi, velocity, finger: id });
          st.key = target || null;
        }
        st.state = thumbOff ? 'off' : st.key ? 'pressed' : st.armed ? 'armed' : 'idle';
      });
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

  /** Thresholds for the current mode, for drawing meters: { on, off } in signal units. */
  function thresholds() {
    if (cfg.mode === 'surface') return { on: cfg.liftThreshold, off: cfg.landThreshold, label: 'lift' };
    if (cfg.mode === 'zone') return { on: 0.5, off: 0.5, label: 'in key' };
    return { on: cfg.pressThreshold, off: cfg.releaseThreshold, label: 'drop' };
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
