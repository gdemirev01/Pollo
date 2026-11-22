// Moving and reshaping the keyboard's quad on screen. Coordinates are normalized
// (0..1). Corner order: top-left, top-right, bottom-right, bottom-left.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const rectQuad = ({ x, y, w, h }) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

export function boundsOf(q) {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export const shiftQuad = (q, dx, dy) => q.map(([x, y]) => [x + dx, y + dy]);

export function isValidQuad(q) {
  if (!Array.isArray(q) || q.length !== 4 || !q.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return false;
  // Convex, consistently wound, and not tiny.
  let sign = 0, area = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
    area += ax * by - bx * ay;
  }
  return Math.abs(area) / 2 > 0.004;
}

export function pointInQuad(q, px, py) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segDist(px, py, [ax, ay], [bx, by]) {
  const vx = bx - ax, vy = by - ay;
  const t = clamp(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1), 0, 1);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * What grabbing (px, py) does: 'c0'..'c3' (a corner), 'e0'..'e3' (edge from
 * corner i to i+1), 'move', or null. `tol` is the grab radius per axis.
 */
export function grabAt(q, px, py, tol = { x: 0.02, y: 0.03 }) {
  // Work in a space where the grab radius is 1 in both directions.
  const s = q.map(([x, y]) => [x / tol.x, y / tol.y]);
  const X = px / tol.x, Y = py / tol.y;
  let best = null, bestD = 1;
  s.forEach(([x, y], i) => { const d = Math.hypot(X - x, Y - y); if (d <= bestD) { bestD = d; best = `c${i}`; } });
  if (best) return best;
  for (let i = 0; i < 4; i++) if (segDist(X, Y, s[i], s[(i + 1) % 4]) <= 1) return `e${i}`;
  return pointInQuad(q, px, py) ? 'move' : null;
}

/** Quad after dragging `mode` by (dx, dy) from `start`; null if the result would be invalid. */
export function dragQuad(start, mode, dx, dy) {
  let q = start.map((p) => [...p]);
  if (mode === 'move') {
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    dx = clamp(dx, -Math.min(...xs), 1 - Math.max(...xs));
    dy = clamp(dy, -Math.min(...ys), 1 - Math.max(...ys));
    return shiftQuad(q, dx, dy);
  }
  const i = Number(mode[1]);
  if (mode[0] === 'c') {
    q[i] = [clamp(q[i][0] + dx, 0, 1), clamp(q[i][1] + dy, 0, 1)];
  } else {
    // Edges move along their own normal, so dragging a side resizes rather than skews.
    const a = q[i], b = q[(i + 1) % 4];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const d = dx * nx + dy * ny;
    for (const k of [i, (i + 1) % 4]) q[k] = [clamp(q[k][0] + d * nx, 0, 1), clamp(q[k][1] + d * ny, 0, 1)];
  }
  return isValidQuad(q) ? q : null;
}

export function cursorFor(mode, q) {
  if (!mode) return 'default';
  if (mode === 'move') return 'move';
  if (mode[0] === 'c') return 'crosshair';
  const i = Number(mode[1]);
  const a = q[i], b = q[(i + 1) % 4];
  return Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? 'ns-resize' : 'ew-resize';
}
