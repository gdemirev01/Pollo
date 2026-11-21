// Turns hand landmarks into note on/off events. Pure logic: no DOM, no audio.
import { hitTest, keyAtX } from './piano.js';

export const FINGERTIPS = [4, 8, 12, 16, 20];
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const WRIST = 0, MIDDLE_MCP = 9;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * @param {object} opts
 *  mode: 'tap' | 'zone'
 *  pressThreshold / releaseThreshold: tap mode, finger drop relative to hand size
 *  zoneMargin: zone mode hysteresis on the keyboard's top edge (normalized units)
 *  useThumb: include the thumb in tap mode
 */
export function createDetector(opts = {}) {
  const cfg = { mode: 'tap', pressThreshold: 0.28, releaseThreshold: 0.16, zoneMargin: 0.015, useThumb: false, smoothing: 0.5, ...opts };
  /** fingerId -> { key, y, t, sx, sy } */
  const fingers = new Map();

  function velocityFrom(speed) {
    // speed: hand-sizes per second, downward. Map to 0.35..1.
    return Math.max(0.35, Math.min(1, 0.35 + speed / 6));
  }

  /**
   * @param hands Array<{ id: string, landmarks: Array<{x,y}> }> in display coords
   * @param layout keyboard layout
   * @param t time in seconds
   * @returns { events: Array<{type:'on'|'off', midi, velocity?, finger}>, active: Map<fingerId, key> }
   */
  function update(hands, layout, t) {
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
          st = { key: null, sx: raw.x, sy: raw.y, py: raw.y, pt: t };
          fingers.set(id, st);
        }
        // Light exponential smoothing to kill jitter.
        const a = cfg.smoothing;
        st.sx = a * st.sx + (1 - a) * raw.x;
        st.sy = a * st.sy + (1 - a) * raw.y;
        const dt = Math.max(1e-3, t - st.pt);
        const speed = (st.sy - st.py) / dt / size; // + is downward
        st.py = st.sy;
        st.pt = t;

        let target = st.key; // default: keep current state

        if (cfg.mode === 'zone') {
          const top = layout.bounds.y;
          const margin = st.key ? -cfg.zoneMargin : cfg.zoneMargin;
          if (st.sy >= top + margin) {
            target = hitTest(layout, st.sx, Math.max(st.sy, top + 1e-6));
          } else {
            target = null;
          }
        } else {
          if (f === 0 && !cfg.useThumb) {
            target = null;
          } else {
            // Drop = how far this tip is below the average of the other
            // non-thumb fingertips, in hand-size units.
            const others = tips.filter((_, j) => j !== f && j !== 0);
            const ref = others.reduce((s, p) => s + p.y, 0) / others.length;
            const drop = (st.sy - ref) / size;
            if (!st.key && drop > cfg.pressThreshold) target = keyAtX(layout, st.sx, st.sy);
            else if (st.key && drop < cfg.releaseThreshold) target = null;
          }
        }

        if (target?.midi !== st.key?.midi) {
          if (st.key) events.push({ type: 'off', midi: st.key.midi, finger: id });
          if (target) events.push({ type: 'on', midi: target.midi, velocity: velocityFrom(Math.max(0, speed)), finger: id });
          st.key = target || null;
        }
      });
    }

    // Hands that disappeared release their notes.
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

  function setOptions(o) { Object.assign(cfg, o); }
  function reset() {
    const events = [];
    for (const [id, st] of fingers) if (st.key) events.push({ type: 'off', midi: st.key.midi, finger: id });
    fingers.clear();
    return events;
  }
  function smoothed(id) { return fingers.get(id); }

  return { update, setOptions, reset, smoothed, config: cfg };
}
