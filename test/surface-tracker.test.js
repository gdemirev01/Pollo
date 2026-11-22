import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceTracker } from '../src/surface-tracker.js';
import { apply, invert, fitHomography, ransacHomography, multiply } from '../src/homography.js';

const W = 320, H = 240;

// A textured table much bigger than the view, so the camera can move around on it.
function makeTable(seed = 5) {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const G = 120, grid = Array.from({ length: G * G }, rnd);
  return (x, y) => { // x, y in table units (pixels of a 960 x 960 table)
    const gx = (x / 960) * (G - 1), gy = (y / 960) * (G - 1);
    if (gx < 0 || gy < 0 || gx >= G - 1 || gy >= G - 1) return 128;
    const ix = gx | 0, iy = gy | 0, fx = gx - ix, fy = gy - iy, v = (i, j) => grid[j * G + i];
    return 255 * ((1 - fx) * (1 - fy) * v(ix, iy) + fx * (1 - fy) * v(ix + 1, iy) + (1 - fx) * fy * v(ix, iy + 1) + fx * fy * v(ix + 1, iy + 1));
  };
}

// Camera view: image pixel (x, y) shows table point view(x, y).
function viewMatrix({ tx = 320, ty = 360, angle = 0, scale = 1 }) {
  const c = Math.cos(angle) / scale, s = Math.sin(angle) / scale;
  // image -> table: rotate/scale about the image centre, then offset
  return [c, -s, tx + W / 2 - (c * W / 2 - s * H / 2), s, c, ty + H / 2 - (s * W / 2 + c * H / 2), 0, 0, 1];
}
function render(table, V, hand) {
  const img = new Float32Array(W * H), mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = apply(V, x, y);
    let v = table(p.x, p.y);
    if (hand && x > hand.x && x < hand.x + 70 && y > hand.y && y < hand.y + 90) { v = 230; mask[y * W + x] = 1; }
    img[y * W + x] = v;
  }
  return { img, mask };
}

test('fitHomography recovers an exact transform; ransac ignores wrong matches', () => {
  const T = [1.1, 0.05, 12, -0.04, 0.95, -7, 0.0002, -0.0001, 1];
  const src = Array.from({ length: 30 }, (_, i) => ({ x: (i * 37) % 300, y: (i * 53) % 220 }));
  const dst = src.map((p) => apply(T, p.x, p.y));
  const F = fitHomography(src, dst);
  for (const p of src) { const a = apply(F, p.x, p.y), b = apply(T, p.x, p.y); assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6); }
  const bad = dst.map((p, i) => (i % 5 === 0 ? { x: p.x + 40, y: p.y - 30 } : p));
  let s = 1; const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const R = ransacHomography(src, bad, { rng });
  assert.equal(R.inliers, 24);
});

function followSequence(views, hand) {
  const table = makeTable();
  const t = createSurfaceTracker();
  const first = render(table, viewMatrix(views[0]), hand);
  assert.ok(t.setReference(first.img, first.mask, W, H) > 30, 'enough texture points');
  let out;
  for (const v of views.slice(1)) {
    const f = render(table, viewMatrix(v), hand);
    out = t.track(f.img, f.mask, W, H);
    assert.ok(out.ok, `lost tracking at ${JSON.stringify(v)}`);
  }
  // Truth: a keyboard corner placed at image point p in the first view sits on table
  // point V0(p); in the last view that table point is at Vn^-1(V0(p)).
  const V0 = viewMatrix(views[0]), Vn = invert(viewMatrix(views.at(-1)));
  const truth = multiply(Vn, V0);
  let worst = 0;
  for (const [x, y] of [[60, 150], [260, 150], [260, 220], [60, 220]]) {
    const a = apply(out.H, x, y), b = apply(truth, x, y);
    worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return worst;
}

test('follows the table as the phone turns and zooms, with a hand in the way', () => {
  const views = Array.from({ length: 13 }, (_, i) => ({ angle: (i / 12) * 0.105, scale: 1 + (i / 12) * 0.05, tx: 320 + i * 2, ty: 360 - i }));
  const worst = followSequence(views, { x: 140, y: 80 });
  assert.ok(worst < 2, `keyboard corners off by ${worst.toFixed(2)} px`);
});

test('keeps following when the phone slides far enough that it needs fresh points', () => {
  const views = Array.from({ length: 25 }, (_, i) => ({ tx: 320 + i * 5, ty: 360 + i * 2 }));
  const worst = followSequence(views, { x: 20, y: 20 });
  assert.ok(worst < 3, `keyboard corners off by ${worst.toFixed(2)} px after 120 px of sliding`);
});

test('says it is lost on a plain surface', () => {
  const plain = () => { let r = 9; return Float32Array.from({ length: W * H }, () => 128 + ((r = (r * 16807) % 2147483647) / 2147483647) * 3); };
  const t = createSurfaceTracker();
  t.setReference(plain(), null, W, H);
  assert.equal(t.track(plain(), null, W, H).ok, false);
});

test('does not chase a small moving object on an otherwise plain table', () => {
  // Plain surface with faint noise, plus a small textured card that slides around.
  let r = 11;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const card = Array.from({ length: 40 * 40 }, () => rnd() * 255);
  const frame = (cx, cy) => {
    const img = Float32Array.from({ length: W * H }, () => 128 + rnd() * 3);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) img[(cy + y) * W + cx + x] = card[y * 40 + x];
    return img;
  };
  const t = createSurfaceTracker();
  t.setReference(frame(100, 100), null, W, H);
  for (let i = 1; i <= 8; i++) {
    const out = t.track(frame(100 + i * 4, 100 + i * 2), null, W, H);
    assert.equal(out.ok, false, `followed the card at step ${i}`);
  }
});

test('an arm sliding over most of the table does not drag the keyboard (camera still)', () => {
  const table = makeTable();
  let r = 21;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const AW = 240, AH = 200;
  const sleeve = Array.from({ length: AW * AH }, () => 60 + rnd() * 150); // textured sleeve, not masked
  const frame = (armX) => {
    const f = render(table, viewMatrix({}), null);
    for (let y = 20; y < 20 + AH; y++) for (let x = 0; x < AW; x++) {
      const X = Math.round(armX) + x;
      if (X >= 0 && X < W) f.img[y * W + X] = sleeve[(y - 20) * AW + x]; // sleeve texture moves with the arm
    }
    return f;
  };
  const t = createSurfaceTracker();
  const first = frame(-400); // arm out of view
  t.setReference(first.img, first.mask, W, H);
  let worst = 0;
  for (let i = 0; i <= 30; i++) {
    const f = frame(-240 + i * 10); // arm slides in from the left and across
    const out = t.track(f.img, f.mask, W, H);
    for (const [x, y] of [[60, 150], [260, 150], [260, 220], [60, 220]]) {
      const p = apply(out.H, x, y);
      worst = Math.max(worst, Math.hypot(p.x - x, p.y - y));
    }
  }
  assert.ok(worst < 2, `keyboard dragged by ${worst.toFixed(1)} px`);
});
