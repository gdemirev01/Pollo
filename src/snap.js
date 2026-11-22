// "Snap to hands": wait until the hands rest still on the table, then place the
// keyboard under the fingertips, lined up with them.

/**
 * Tracks how long the hands have stayed still.
 * add() takes {id -> {x, y}} fingertips and returns progress 0..1.
 */
export function createSteadiness({ hold = 1.2, maxMove = 0.025 } = {}) {
  let since = null, ref = null;
  return {
    add(t, tips) {
      const ids = Object.keys(tips);
      const moved = !ref || ids.length === 0 || ids.length !== Object.keys(ref).length ||
        ids.some((id) => !ref[id] || Math.hypot(tips[id].x - ref[id].x, tips[id].y - ref[id].y) > maxMove);
      if (moved) { since = t; ref = tips; }
      return ids.length ? Math.min(1, (t - since) / hold) : 0;
    },
    reset() { since = null; ref = null; },
  };
}

/**
 * Keyboard quad for fingertips resting on the table.
 * @param tips   fingertip points (index..pinky of each hand), normalized
 * @param wrists wrist points, to tell which side is "toward the player"
 * @param aspect frame width / height, so angles are measured in real pixels
 * @param opts.tipV where the fingertips sit across the keys (0 = far end, 1 = near end)
 * @param opts.orient 'auto': face the keys toward the wrists (camera above the table);
 *   'upright': black keys always at the top of the picture (camera in front of you,
 *   where fingertips appear below the wrists)
 */
export function snapQuad(tips, wrists, aspect, { tipV = 0.72, margin = 0.15, depthRatio = 0.4, maxAngle = 35, orient = 'auto' } = {}) {
  if (tips.length < 2 || !wrists.length) return null;
  const P = tips.map((p) => [p.x * aspect, p.y]);
  const cx = P.reduce((s, p) => s + p[0], 0) / P.length;
  const cy = P.reduce((s, p) => s + p[1], 0) / P.length;
  // Principal direction of the fingertip line.
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of P) { sxx += (x - cx) ** 2; sxy += (x - cx) * (y - cy); syy += (y - cy) ** 2; }
  let ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const lim = (maxAngle * Math.PI) / 180;
  ang = Math.max(-lim, Math.min(lim, ang));
  let u = [Math.cos(ang), Math.sin(ang)]; // along the keys, low to high notes
  let n = [-u[1], u[0]]; // across the keys, far end to the player's side
  // n must point from the fingertips toward the wrists. If it doesn't, the player
  // is at the top of the picture: turn the whole keyboard round (u and n both flip),
  // so low notes stay on the player's left.
  const wx = wrists.reduce((s, p) => s + p.x * aspect, 0) / wrists.length;
  const wy = wrists.reduce((s, p) => s + p.y, 0) / wrists.length;
  const toward = orient === 'upright' ? n[1] : (wx - cx) * n[0] + (wy - cy) * n[1];
  if (toward < 0) { u = [-u[0], -u[1]]; n = [-n[0], -n[1]]; }

  const proj = P.map(([x, y]) => (x - cx) * u[0] + (y - cy) * u[1]);
  const lo = Math.min(...proj), hi = Math.max(...proj);
  const span = hi - lo;
  const width = Math.min(aspect * 0.98, span * (1 + 2 * margin) + 0.1);
  const mid = (lo + hi) / 2;
  const depth = width * depthRatio;
  const c = [cx + u[0] * mid, cy + u[1] * mid];
  const corner = (a, b) => [c[0] + u[0] * a + n[0] * b, c[1] + u[1] * a + n[1] * b];
  let q = [corner(-width / 2, -tipV * depth), corner(width / 2, -tipV * depth), corner(width / 2, (1 - tipV) * depth), corner(-width / 2, (1 - tipV) * depth)];
  q = q.map(([x, y]) => [x / aspect, y]);
  // Too big for the screen: shrink it around its centre. Then nudge it back on screen.
  let xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
  const k = Math.min(1, 0.98 / bw, 0.98 / bh);
  if (k < 1) {
    const mx = (Math.max(...xs) + Math.min(...xs)) / 2, my = (Math.max(...ys) + Math.min(...ys)) / 2;
    q = q.map(([x, y]) => [mx + (x - mx) * k, my + (y - my) * k]);
    xs = q.map((p) => p[0]); ys = q.map((p) => p[1]);
  }
  const dx = Math.min(0, 1 - Math.max(...xs)) - Math.min(0, Math.min(...xs));
  const dy = Math.min(0, 1 - Math.max(...ys)) - Math.min(0, Math.min(...ys));
  return q.map(([x, y]) => [x + dx, y + dy]);
}
