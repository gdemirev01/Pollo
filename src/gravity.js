// Keeping the keyboard flat on a level table using the phone's motion sensors.
//
// The phone reports how it is rotated (deviceorientation: alpha, beta, gamma).
// From that we know where "down" is for the camera, so the table plane is known
// up to its distance, which doesn't matter for how things look (everything is in
// units of the camera's height above the table). The keyboard is stored as four
// corners on that table in a world frame (Z up, camera at the origin, table at
// Z = -1); each frame they are projected with the phone's current rotation, so
// turning or tilting the phone keeps the keyboard where it was on the table.
// Sliding the phone sideways can't be seen this way (the sensors measure
// rotation), which is what the visual table tracker is for.

const rad = (d) => (d * Math.PI) / 180;

/** Device -> world rotation for deviceorientation angles (W3C: R = Rz(alpha) Rx(beta) Ry(gamma)), row-major 3x3. */
export function deviceRotation(alpha, beta, gamma) {
  const ca = Math.cos(rad(alpha)), sa = Math.sin(rad(alpha));
  const cb = Math.cos(rad(beta)), sb = Math.sin(rad(beta));
  const cg = Math.cos(rad(gamma)), sg = Math.sin(rad(gamma));
  const Rz = [ca, -sa, 0, sa, ca, 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, cb, -sb, 0, sb, cb];
  const Ry = [cg, 0, sg, 0, 1, 0, -sg, 0, cg];
  return mul(mul(Rz, Rx), Ry);
}

export function mul(A, B) {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}
const T = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const mv = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(...a) || 1; return scale(a, 1 / n); };

/**
 * Camera -> world rotation. Camera frame: X right and Y down in the picture as
 * shown (after mirroring), Z forward out of the lens.
 * @param facing 'environment' (back camera) or 'user' (front camera, shown mirrored)
 * @param screenAngle screen.orientation.angle (0 portrait, 90/270 landscape)
 */
export function cameraToWorld(alpha, beta, gamma, facing = 'environment', screenAngle = 0) {
  const Rdev = deviceRotation(alpha, beta, gamma);
  // Picture axes in device coordinates (portrait): x right, y toward the top of the phone.
  const Mcd = facing === 'user' ? [1, 0, 0, 0, -1, 0, 0, 0, 1] : [1, 0, 0, 0, -1, 0, 0, 0, -1];
  // In landscape the picture is turned relative to the phone.
  const t = rad(screenAngle || 0), c = Math.cos(t), s = Math.sin(t);
  const Rscreen = [c, -s, 0, s, c, 0, 0, 0, 1];
  return mul(Rdev, mul(Rscreen, Mcd));
}

/** Camera intrinsics for a picture size and angle of view across its longer side. */
export function intrinsics(width, height, fovDeg) {
  const f = Math.max(width, height) / 2 / Math.tan(rad(fovDeg) / 2);
  return { f, cx: width / 2, cy: height / 2 };
}

/** Where the ray through pixel (x, y) meets the table (world Z = -1), or null if it doesn't. */
export function rayToTable(K, Rcw, x, y) {
  const d = mv(Rcw, [(x - K.cx) / K.f, (y - K.cy) / K.f, 1]);
  if (d[2] > -1e-4) return null; // looking at or above the horizon
  return scale(d, -1 / d[2]);
}

/** Pixel position of a world point, or null if it's behind the camera. */
export function project(K, Rcw, P) {
  const c = mv(T(Rcw), P);
  if (c[2] <= 1e-6) return null;
  return { x: (K.f * c[0]) / c[2] + K.cx, y: (K.f * c[1]) / c[2] + K.cy };
}

/** Keyboard corners on the table from its corners on screen (pixels). */
export function worldFromQuad(K, Rcw, quadPx) {
  const pts = quadPx.map(([x, y]) => rayToTable(K, Rcw, x, y));
  return pts.every(Boolean) ? pts : null;
}

/** Keyboard corners on screen (pixels) from its corners on the table. */
export function quadFromWorld(K, Rcw, corners) {
  const q = corners.map((P) => project(K, Rcw, P));
  return q.every(Boolean) ? q.map((p) => [p.x, p.y]) : null;
}

const KEY_DEPTH_PER_WIDTH = 15 / 2.35;

/**
 * Place the keyboard flat on the table under the hands, in true perspective.
 * @param hands per hand: { tips: [index..pinky] pixels, knuckles: [index MCP, pinky MCP] pixels, wrist } pixels
 * @returns { corners (world), keyCount } or null
 */
export function snapToTable(K, Rcw, hands, keyCount, { tipV = 0.72, fits = null } = {}) {
  const onTable = (p) => rayToTable(K, Rcw, p.x, p.y);
  const tips = [], gaps = [];
  let axis = [0, 0, 0], towardWrist = [0, 0, 0];
  for (const h of hands) {
    const t = h.tips.map(onTable), k = h.knuckles.map(onTable), w = onTable(h.wrist);
    if (t.some((p) => !p) || k.some((p) => !p) || !w) continue;
    tips.push(...t);
    for (let i = 1; i < t.length; i++) gaps.push(Math.hypot(...sub(t[i], t[i - 1])));
    // Across the hand: the knuckle line (straighter than the fingertips), as an axis.
    let a = unit(add(sub(k[1], k[0]), sub(t[t.length - 1], t[0])));
    if (dot(a, axis) < 0) a = scale(a, -1);
    axis = add(axis, a);
    const tc = scale(t.reduce(add, [0, 0, 0]), 1 / t.length);
    towardWrist = add(towardWrist, sub(w, tc));
  }
  if (tips.length < 2 || !gaps.length) return null;
  gaps.sort((p, q) => p - q);
  const keyW = gaps[gaps.length >> 1];
  const up = [0, 0, 1];
  // n: across the keys, toward the player (the wrists); u: low to high notes = player's left to right.
  let n = unit(cross(up, unit([axis[0], axis[1], 0])));
  if (dot(n, towardWrist) < 0) n = scale(n, -1);
  const u = cross(scale(n, -1), up); // forward x up = right
  const center = scale(tips.reduce(add, [0, 0, 0]), 1 / tips.length);
  const proj = tips.map((p) => dot(sub(p, center), u));
  const mid = add(center, scale(u, (Math.min(...proj) + Math.max(...proj)) / 2));
  const build = (count) => {
    const w = count * keyW, d = keyW * KEY_DEPTH_PER_WIDTH;
    const at = (a, b) => add(add(mid, scale(u, a)), scale(n, b));
    return [at(-w / 2, -tipV * d), at(w / 2, -tipV * d), at(w / 2, (1 - tipV) * d), at(-w / 2, (1 - tipV) * d)];
  };
  // Fewer keys if they wouldn't fit on screen.
  let count = keyCount;
  while (count > 5 && fits && !fits(build(count))) count--;
  return { corners: build(count), keyCount: count };
}
