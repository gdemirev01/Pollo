// Keyboard layout + hit testing. All coordinates are normalized (0..1) in the
// *displayed* (mirrored) frame, so they line up with what the player sees.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

export const isBlack = (midi) => BLACK_PCS.has(((midi % 12) + 12) % 12);
export const noteName = (midi) => NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

/**
 * Build a keyboard starting at `startMidi` (snapped down to a white key) with
 * `whiteCount` white keys, placed in the rectangle {x, y, width, height}.
 */
export function buildLayout({ startMidi = 60, whiteCount = 14, x = 0.02, y = 0.62, width = 0.96, height = 0.34 } = {}) {
  let midi = startMidi;
  while (isBlack(midi)) midi--;
  const ww = width / whiteCount;
  const bw = ww * 0.6;
  const bh = height * 0.6;
  const keys = [];
  let w = 0;
  while (w < whiteCount) {
    if (isBlack(midi)) {
      // Black key sits centered on the boundary before the current white key.
      keys.push({ midi, black: true, name: noteName(midi), x: x + w * ww - bw / 2, y, w: bw, h: bh });
    } else {
      keys.push({ midi, black: false, name: noteName(midi), x: x + w * ww, y, w: ww, h: height });
      w++;
    }
    midi++;
  }
  // A trailing black key would hang off the right edge; layouts end on a white key.
  return { keys, bounds: { x, y, width, height } };
}

const inside = (k, px, py) => px >= k.x && px < k.x + k.w && py >= k.y && py < k.y + k.h;

/** Key under a point, black keys take priority (they're drawn on top). */
export function hitTest(layout, px, py) {
  for (const k of layout.keys) if (k.black && inside(k, px, py)) return k;
  for (const k of layout.keys) if (!k.black && inside(k, px, py)) return k;
  return null;
}

/**
 * Key for a horizontal position only (used by tap mode, where the finger's
 * height is about the gesture, not the key). Black keys are chosen when the
 * point is in the upper (black-key) band of the keyboard or above it.
 */
export function keyAtX(layout, px, py) {
  const { y, height } = layout.bounds;
  const inBlackBand = py < y + height * 0.6;
  if (inBlackBand) {
    for (const k of layout.keys) if (k.black && px >= k.x && px < k.x + k.w) return k;
  }
  for (const k of layout.keys) if (!k.black && px >= k.x && px < k.x + k.w) return k;
  return null;
}
