import { isValidQuad, rectQuad } from './layout-editor.js';

// Settings with defaults, remembered in this browser between visits.
const KEY = 'pollo.settings.v1';

export const DEFAULTS = Object.freeze({
  mode: 'tap',
  startMidi: 60,
  whiteCount: 14,
  quad: [[0.03, 0.6], [0.97, 0.6], [0.97, 0.94], [0.03, 0.94]], // keyboard corners: TL, TR, BR, BL
  anchor: true,
  autoSnap: true,
  calibration: {},
  look3d: true, // keys drawn as 3D blocks standing on the table
  keyHeight: 1, // 1 = real piano proportions
  fov: 65, // camera angle of view across the picture's long side, degrees
  occlusion: true, // draw the hands in front of the keys
  useMotion: true, // use the phone's motion sensors to keep the keyboard flat on the table
  autoSize: true, // keep keys one finger-gap wide as the phone moves closer or further // tap calibration per mode ('tap', 'surface'), from calibrate.js // place the keyboard under the hands when they're first seen
  camera: 'facing:user',
  mirror: true,
  flip: false,
  sensitivity: 6,
  useThumb: false,
  volume: 0.7,
  reverb: 0.22,
  skeleton: true,
  tracking: true,
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
      if (k === 'quad') continue;
      if (typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
    }
    if (isValidQuad(saved.quad)) s.quad = saved.quad;
    else if (saved.kb && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(saved.kb[k]))) s.quad = rectQuad(saved.kb); // older saved layout
  } catch { /* storage blocked or corrupt: use defaults */ }
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export const defaultQuad = () => DEFAULTS.quad.map((p) => [...p]);
