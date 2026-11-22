// Keeps track of how the table moves in the picture when the phone moves:
// slides, turns, zooms and tilts. Works on small grey images:
//  1. Picks well-textured points on the table (corners), away from the hands.
//  2. Each frame, finds every point again near where the current estimate puts
//     it. The point's patch is warped by that estimate first, so it still
//     matches after the view has turned or zoomed.
//  3. Fits one perspective transform to all the matches, ignoring bad ones.
//  4. When many points have left the picture, starts again from the current
//     frame, remembering how far it had already moved.
// track() returns H: points in the frame where the keyboard was placed ->
// points in the current frame (pixels of the working image).
import { apply, invert, multiply, ransacHomography } from './homography.js';

const R = 5; // patch half-size: 11 x 11 pixels
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function sample(img, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy;
}

function halve(img, w, h) {
  const W = w >> 1, H = h >> 1, out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 2 * y * w + 2 * x;
    out[y * W + x] = (img[i] + img[i + 1] + img[i + w] + img[i + w + 1]) / 4;
  }
  return { img: out, w: W, h: H };
}

/** Corner strength (Harris) at each pixel; strongest few per grid cell, outside the mask. */
function findCorners(img, w, h, mask, max, border) {
  const Ixx = new Float32Array(w * h), Iyy = new Float32Array(w * h), Ixy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = (img[i + 1] - img[i - 1]) / 2, gy = (img[i + w] - img[i - w]) / 2;
    Ixx[i] = gx * gx; Iyy[i] = gy * gy; Ixy[i] = gx * gy;
  }
  const cell = 16, pts = [];
  const resp = new Float32Array(w * h);
  for (let y = border; y < h - border; y++) for (let x = border; x < w - border; x++) {
    let a = 0, b = 0, c = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const j = (y + dy) * w + x + dx;
      a += Ixx[j]; b += Iyy[j]; c += Ixy[j];
    }
    resp[y * w + x] = a * b - c * c - 0.05 * (a + b) * (a + b);
  }
  // Stay a few pixels clear of the hands: their edges make strong, moving "corners".
  const nearMask = (x, y) => mask && (mask[y * w + x] || mask[y * w + Math.max(0, x - 4)] || mask[y * w + Math.min(w - 1, x + 4)] ||
    mask[Math.max(0, y - 4) * w + x] || mask[Math.min(h - 1, y + 4) * w + x]);
  for (let cy = border; cy < h - border; cy += cell) for (let cx = border; cx < w - border; cx += cell) {
    let best = 0, bx = -1, by = -1;
    for (let y = cy; y < Math.min(cy + cell, h - border); y++) for (let x = cx; x < Math.min(cx + cell, w - border); x++) {
      const r = resp[y * w + x];
      if (r > best && !nearMask(x, y)) { best = r; bx = x; by = y; }
    }
    if (bx >= 0) pts.push({ x: bx, y: by, r: best });
  }
  // Keep cells whose best corner is reasonably strong compared with a typical cell,
  // so one extreme corner (glare, an edge) doesn't make the rest of the table look weak.
  const sorted = pts.map((p) => p.r).sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length * 0.75)] || 0;
  const strong = pts.filter((p) => p.r > Math.max(1e-3, typical * 0.05));
  pts.length = 0;
  pts.push(...strong);
  pts.sort((p, q) => q.r - p.r);
  return pts.slice(0, max).map(({ x, y }) => ({ x, y }));
}

/** Patch the reference looks like around `pred` in the current view (step = pixel spacing). */
function warpedTemplate(ref, Hinv, pred, step, scale) {
  const t = new Float32Array((2 * R + 1) ** 2);
  let k = 0, s = 0, s2 = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const q = apply(Hinv, pred.x + dx * step, pred.y + dy * step);
    const v = sample(ref.img, ref.w, ref.h, q.x / scale, q.y / scale);
    if (Number.isNaN(v)) return null;
    t[k++] = v; s += v; s2 += v * v;
  }
  const n = t.length, mean = s / n, sd = Math.sqrt(Math.max(1e-6, s2 / n - mean * mean));
  if (sd < 2) return null; // too plain to match
  for (let i = 0; i < n; i++) t[i] = (t[i] - mean) / sd;
  return t;
}

/** Normalized cross-correlation of the template with the image window centred at (cx, cy). */
function ncc(img, w, h, cx, cy, t) {
  if (cx < R || cy < R || cx >= w - R || cy >= h - R) return -1;
  let s = 0, s2 = 0, st = 0, k = 0;
  for (let dy = -R; dy <= R; dy++) {
    const row = (cy + dy) * w + cx;
    for (let dx = -R; dx <= R; dx++) { const v = img[row + dx]; s += v; s2 += v * v; st += v * t[k++]; }
  }
  const n = t.length, mean = s / n, sd = Math.sqrt(Math.max(1e-6, s2 / n - mean * mean));
  return st / (n * sd); // template already has zero mean, unit sd
}

function searchBest(img, w, h, cx, cy, radius, t) {
  let best = -2, bx = cx, by = cy;
  for (let y = cy - radius; y <= cy + radius; y++) for (let x = cx - radius; x <= cx + radius; x++) {
    const s = ncc(img, w, h, x, y, t);
    if (s > best) { best = s; bx = x; by = y; }
  }
  return { x: bx, y: by, score: best };
}

function subpixel(img, w, h, p, t) {
  const at = (x, y) => ncc(img, w, h, x, y, t);
  const c = p.score;
  const l = at(p.x - 1, p.y), r = at(p.x + 1, p.y), u = at(p.x, p.y - 1), d = at(p.x, p.y + 1);
  const ox = l + r - 2 * c < 0 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * (l + r - 2 * c)))) : 0;
  const oy = u + d - 2 * c < 0 ? Math.max(-0.5, Math.min(0.5, (u - d) / (2 * (u + d - 2 * c)))) : 0;
  return { x: p.x + ox, y: p.y + oy };
}

function sane(H, w, h) {
  const c = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => apply(H, x, y));
  if (c.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  let area = 0, sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4], d = c[(i + 2) % 4];
    const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
    area += a.x * b.y - b.x * a.y;
  }
  const ratio = Math.abs(area) / 2 / (w * h);
  return ratio > 0.25 && ratio < 4;
}

/** Share of the image covered by the bounding box of these points. */
function spread(pts, w, h) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / (w * h);
}

/** Largest distance any image corner moves between two transforms. */
function cornerJump(A, B, w, h) {
  let m = 0;
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const a = apply(A, x, y), b = apply(B, x, y);
    m = Math.max(m, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return m;
}

// Repeatable "random" picks for the robust fit, so the same frames give the same result.
function seeded() { let s = 12345; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

export function createSurfaceTracker({ maxFeatures = 70, search = 6, lostSearch = 14, minInliers = 15, minSpread = 0.12, holdBelow = 0.3, minFeatures = 20 } = {}) {
  let ref = null; // { full, half, features }
  let H = IDENTITY; // reference frame -> current frame
  let base = IDENTITY; // original placement frame -> reference frame
  let lost = 0;
  let lastInliers = 0;

  function setFrame(gray, mask, w, h) {
    const full = { img: gray, w, h };
    const features = findCorners(gray, w, h, mask, maxFeatures, R * 2 + 2);
    ref = { full, half: halve(gray, w, h), features };
  }

  return {
    /** Start from this frame: the keyboard's current position is the placement. */
    setReference(gray, mask, w, h) {
      setFrame(gray, mask, w, h);
      H = IDENTITY; base = IDENTITY; lost = 0;
      return ref.features.length;
    },
    clear() { ref = null; H = IDENTITY; base = IDENTITY; },
    get hasReference() { return !!ref; },
    get features() { return ref ? ref.features.length : 0; },

    /** @returns { H, ok, inliers } — H maps the placement frame to this frame. */
    track(gray, mask, w, h) {
      if (!ref || ref.full.w !== w || ref.full.h !== h) return { H: multiply(H, base), ok: false, inliers: 0 };
      const cur = { full: { img: gray, w, h }, half: halve(gray, w, h) };
      const Hinv = invert(H);
      const radius = lost ? lostSearch : search;
      const src = [], dst = [];
      let inFrame = 0; // points still inside the picture (covered or not)
      for (const p of ref.features) {
        const pred = apply(H, p.x, p.y);
        if (pred.x < 2 * R + 2 || pred.y < 2 * R + 2 || pred.x > w - 2 * R - 3 || pred.y > h - 2 * R - 3) continue;
        inFrame++;
        if (mask && mask[(pred.y | 0) * w + (pred.x | 0)]) continue;
        // Coarse: half resolution, wide search.
        const th = warpedTemplate(ref.half, Hinv, pred, 2, 2);
        if (!th) continue;
        const c = searchBest(cur.half.img, cur.half.w, cur.half.h, Math.round(pred.x / 2), Math.round(pred.y / 2), radius, th);
        if (c.score < 0.6) continue;
        // Fine: full resolution, small search around the coarse hit.
        const tf = warpedTemplate(ref.full, Hinv, pred, 1, 1);
        if (!tf) continue;
        const f = searchBest(gray, w, h, c.x * 2, c.y * 2, 2, tf);
        if (f.score < 0.8) continue;
        src.push(p);
        dst.push(subpixel(gray, w, h, f, tf));
      }

      if (ref.features.length < minFeatures) { lost++; return { H: multiply(H, base), ok: false, inliers: 0 }; }
      const fit = src.length >= 8 ? ransacHomography(src, dst, { threshold: 2, rng: seeded() }) : null;
      let good = !!fit && fit.inliers >= Math.max(minInliers, src.length * 0.3) && sane(fit.H, w, h);
      let hold = false;
      if (good) {
        const idx = src.map((_, i) => i).filter((i) => { const p = apply(fit.H, src[i].x, src[i].y); return Math.hypot(p.x - dst[i].x, p.y - dst[i].y) < 2; });
        const cover = spread(idx.map((i) => dst[i]), w, h);
        if (cover < minSpread) good = false; // the agreeing points are one small thing moving, not the table
        // Most of the table hidden (hands and arms over it while you play, when the phone
        // is almost always still): the few points left can't pin the view down well,
        // so keep the keyboard exactly where it is until more table shows again.
        else if (cover < holdBelow || idx.length < inFrame * 0.4) hold = true;
        // The view can't jump further than a phone plausibly moves in one frame.
        else if (cornerJump(fit.H, H, w, h) > (lost ? 0.45 : 0.25) * w) good = false;
      }
      if (good) {
        // Dead zone: ignore changes smaller than a pixel or two, so the keyboard stays
        // still instead of shimmering. Real slow drift adds up past it and is followed.
        if (!hold && cornerJump(fit.H, H, w, h) > 1.5) H = fit.H;
        lost = 0;
        lastInliers = fit.inliers;
        // Many points have left the picture (the phone moved): start again from this
        // frame. Points that are only covered (hands, arms) don't count: picking fresh
        // points then could land them on an arm, and the keyboard would follow the arm.
        if (!hold && inFrame < ref.features.length * 0.5) {
          base = multiply(H, base);
          H = IDENTITY;
          setFrame(gray, mask, w, h);
        }
        return { H: multiply(H, base), ok: true, inliers: fit.inliers };
      }
      lost++;
      lastInliers = fit ? fit.inliers : 0;
      return { H: multiply(H, base), ok: false, inliers: lastInliers };
    },
  };
}
