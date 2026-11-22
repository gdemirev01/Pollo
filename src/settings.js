// Settings with defaults, remembered in this browser between visits.
const KEY = 'pollo.settings.v1';

export const DEFAULTS = Object.freeze({
  mode: 'tap',
  startMidi: 60,
  whiteCount: 14,
  kb: { x: 0.03, y: 0.6, w: 0.94, h: 0.34 },
  camera: 'facing:user',
  mirror: true,
  flip: false,
  sensitivity: 6,
  useThumb: false,
  volume: 0.7,
  reverb: 0.22,
  skeleton: true,
  labels: 'c',
  opacity: 0.55,
  accent: '#facc15',
});

const fresh = () => JSON.parse(JSON.stringify(DEFAULTS));

export function loadSettings() {
  const s = fresh();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k of Object.keys(DEFAULTS)) {
      if (k === 'kb') continue;
      if (typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
    }
    const kb = saved.kb;
    if (kb && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(kb[k]))) s.kb = { x: kb.x, y: kb.y, w: kb.w, h: kb.h };
  } catch { /* storage blocked or corrupt: use defaults */ }
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export const defaultKeyboardRect = () => ({ ...DEFAULTS.kb });
