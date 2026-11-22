// Keeps white keys about one finger-gap wide while you play, so the keyboard
// stays the right size when the phone moves closer or further away.
// Scaling happens around the hand, so the key under your hand stays the same
// and moving your hand sideways still plays other keys.
import { placement } from './homography.js';
import { fingerSpacing } from './snap.js';
import { isValidQuad } from './layout-editor.js';

/** Width of one white key, measured at screen point (x, y), in aspect-scaled units. */
export function keyWidthAt(quad, whiteCount, x, y, aspect) {
  const P = placement(quad);
  const l = P.toLocal(x, y);
  const du = 1 / whiteCount;
  const a = P.toScreen(l.x - du / 2, l.y), b = P.toScreen(l.x + du / 2, l.y);
  return { width: Math.hypot((b.x - a.x) * aspect, b.y - a.y), local: l };
}

/**
 * One smoothing step. Returns a new quad, or null to leave it as it is.
 * @param hands array of fingertip arrays (index..pinky) per hand, normalized
 * @param opts.dt seconds since the last step; tau how fast it settles; deadband how close counts as right
 */
export function autoSizeStep(quad, whiteCount, hands, aspect, { dt = 1 / 30, tau = 0.8, deadband = 0.1 } = {}) {
  const target = fingerSpacing(hands, aspect);
  if (!(target > 0)) return null;
  const pts = hands.flat();
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const { width, local } = keyWidthAt(quad, whiteCount, cx, cy, aspect);
  // Only when the hand is over or near the keyboard.
  if (!(local.x > -0.2 && local.x < 1.2 && local.y > -0.6 && local.y < 1.6)) return null;
  const r = target / width;
  if (!Number.isFinite(r) || Math.abs(Math.log(r)) < deadband) return null;
  const k = Math.exp(Math.log(r) * Math.min(1, dt / tau));
  // Uniform scaling about the hand (x in aspect-scaled units so it's uniform in pixels).
  const q = quad.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
  return isValidQuad(q) ? q : null;
}
