// Geometry for dragging and resizing the on-screen keyboard.
// Rects are normalized {x, y, w, h} in the displayed frame (0..1).

export const MIN_W = 0.12;
export const MIN_H = 0.08;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * What grabbing the point (px, py) would do: 'move', a resize handle
 * ('n','s','e','w','ne','nw','se','sw'), or null when it misses the keyboard.
 * `tol` is the grab distance around edges, per axis, in normalized units.
 */
export function grabAt(r, px, py, tol = { x: 0.02, y: 0.03 }) {
  const inX = px >= r.x - tol.x && px <= r.x + r.w + tol.x;
  const inY = py >= r.y - tol.y && py <= r.y + r.h + tol.y;
  if (!inX || !inY) return null;
  const v = Math.abs(py - r.y) <= tol.y ? 'n' : Math.abs(py - (r.y + r.h)) <= tol.y ? 's' : '';
  const h = Math.abs(px - r.x) <= tol.x ? 'w' : Math.abs(px - (r.x + r.w)) <= tol.x ? 'e' : '';
  return v + h || 'move';
}

/** New rect after dragging `mode` by (dx, dy) from the starting rect `s`. Stays on screen. */
export function dragRect(s, mode, dx, dy) {
  let { x, y, w, h } = s;
  if (mode === 'move') return { x: clamp(x + dx, 0, 1 - w), y: clamp(y + dy, 0, 1 - h), w, h };
  if (mode.includes('w')) { const nx = clamp(x + dx, 0, x + w - MIN_W); w += x - nx; x = nx; }
  if (mode.includes('e')) w = clamp(w + dx, MIN_W, 1 - x);
  if (mode.includes('n')) { const ny = clamp(y + dy, 0, y + h - MIN_H); h += y - ny; y = ny; }
  if (mode.includes('s')) h = clamp(h + dy, MIN_H, 1 - y);
  return { x, y, w, h };
}

export function cursorFor(mode) {
  return { move: 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' }[mode] || 'default';
}
