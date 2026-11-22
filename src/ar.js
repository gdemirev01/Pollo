// 3D keys standing on the table.
//
// The keyboard's four corners on screen give the table plane's perspective (a
// homography). With the camera's angle of view we can split that into where the
// camera is relative to the table (rotation + position), which tells us which way
// "up from the table" points at every spot in the picture. Then each key is drawn
// as a solid block in real piano proportions.
//
// Keyboard coordinates are in centimetres on the table: X across the keys (0 at
// the lowest key), Y from the far end (0) toward the player, Z up from the table.
import { squareToQuad, invert } from './homography.js';

export const WHITE_KEY_CM = 2.35; // width of a white key
export const KEY_DEPTH_CM = 15; // length of a white key
export const WHITE_HEIGHT_CM = 1.6; // how far a white key stands above the table
export const BLACK_EXTRA_CM = 1.1; // black keys stand this much higher

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

/**
 * Camera pose for a keyboard quad.
 * @param quad four corners in pixels (TL, TR, BR, BL = far-left, far-right, near-right, near-left)
 * @param width,height picture size in pixels
 * @param fovDeg the camera's angle of view across the picture's longer side
 * @param keyboardCm { w, d } real size of the keyboard on the table
 * @returns { project(X, Y, Z) -> {x, y, depth} } in pixels, or null
 */
export function poseFromQuad(quad, width, height, fovDeg, keyboardCm) {
  const f = Math.max(width, height) / 2 / Math.tan((fovDeg * Math.PI) / 360);
  const cx = width / 2, cy = height / 2;
  // Table centimetres -> picture pixels.
  const Hq = squareToQuad(quad);
  const Hs = [1 / keyboardCm.w, 0, 0, 0, 1 / keyboardCm.d, 0, 0, 0, 1];
  const H = mul3(Hq, Hs);
  // M = K^-1 H: columns are (scaled) the table's X axis, Y axis and origin seen from the camera.
  const Kinv = invert([f, 0, cx, 0, f, cy, 0, 0, 1]);
  const M = mul3(Kinv, H);
  let r1 = [M[0], M[3], M[6]], r2 = [M[1], M[4], M[7]], t = [M[2], M[5], M[8]];
  const s = 2 / (norm(r1) + norm(r2));
  if (!Number.isFinite(s)) return null;
  r1 = r1.map((v) => v * s); r2 = r2.map((v) => v * s); t = t.map((v) => v * s);
  if (t[2] < 0) { r1 = r1.map((v) => -v); r2 = r2.map((v) => -v); t = t.map((v) => -v); } // table in front of the camera
  let up = cross(r1, r2);
  const n = norm(up);
  if (!(n > 1e-9)) return null;
  up = up.map((v) => v / n);
  if (dot(up, t) > 0) up = up.map((v) => -v); // "up" points from the table toward the camera
  const project = (X, Y, Z) => {
    const P = [0, 1, 2].map((i) => X * r1[i] + Y * r2[i] + Z * up[i] + t[i]);
    const z = Math.max(1e-6, P[2]);
    return { x: (f * P[0]) / z + cx, y: (f * P[1]) / z + cy, depth: P[2] };
  };
  return { project, up, t };
}

function mul3(A, B) {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}

/** Real size of the keyboard for a layout (unit square keys). */
export const keyboardSize = (whiteCount) => ({ w: whiteCount * WHITE_KEY_CM, d: KEY_DEPTH_CM });

/**
 * Boxes for every key, in centimetres, with which faces are visible and their
 * screen polygons, ordered back to front for drawing.
 * @param layout keys in unit-square coordinates (x, y, w, h)
 * @param pressed Set of midi numbers held down (they sink)
 * @param heightScale 0 = flat, 1 = real proportions
 */
export function keyBoxes(pose, layout, size, pressed, heightScale = 1) {
  const gap = 0.08; // cm between keys
  const boxes = layout.keys.map((k) => {
    const X0 = k.x * size.w + gap, X1 = (k.x + k.w) * size.w - gap;
    const Y0 = k.y * size.d, Y1 = (k.y + k.h) * size.d - (k.black ? 0 : gap);
    const down = pressed.has(k.midi);
    let top = (k.black ? WHITE_HEIGHT_CM + BLACK_EXTRA_CM : WHITE_HEIGHT_CM) * heightScale;
    if (down) top *= k.black ? 0.75 : 0.55;
    return { key: k, faces: boxFaces(pose, X0, X1, Y0, Y1, 0, top), depth: pose.project((X0 + X1) / 2, (Y0 + Y1) / 2, top / 2).depth, down };
  });
  // White keys first (they're lower), each group far to near.
  return boxes.sort((a, b) => (a.key.black - b.key.black) || b.depth - a.depth);
}

const area = (pts) => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
};

/**
 * Screen polygons of a box's faces that face the camera. Each face's corners are
 * listed counter-clockwise seen from outside, so a face is visible exactly when
 * it winds the same way on screen as the top (which always faces the camera).
 */
export function boxFaces(pose, X0, X1, Y0, Y1, Z0, Z1) {
  const P = (x, y, z) => pose.project(x, y, z);
  const faces = {
    top: [P(X0, Y0, Z1), P(X1, Y0, Z1), P(X1, Y1, Z1), P(X0, Y1, Z1)],
    front: [P(X0, Y1, Z0), P(X0, Y1, Z1), P(X1, Y1, Z1), P(X1, Y1, Z0)],
    back: [P(X1, Y0, Z0), P(X1, Y0, Z1), P(X0, Y0, Z1), P(X0, Y0, Z0)],
    right: [P(X1, Y1, Z0), P(X1, Y1, Z1), P(X1, Y0, Z1), P(X1, Y0, Z0)],
    left: [P(X0, Y0, Z0), P(X0, Y0, Z1), P(X0, Y1, Z1), P(X0, Y1, Z0)],
  };
  const sTop = Math.sign(area(faces.top));
  const out = [];
  for (const name of ['back', 'left', 'right', 'front']) if (Z1 - Z0 > 1e-6 && Math.sign(area(faces[name])) === sTop && Math.abs(area(faces[name])) > 0.5) out.push({ name, pts: faces[name] });
  out.push({ name: 'top', pts: faces.top });
  return out;
}
