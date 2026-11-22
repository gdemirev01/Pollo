// Follows the table if the camera shifts: compares the current frame with a
// reference frame of the table (hands masked out) and finds the translation
// that lines them up best. Coarse-to-fine block matching on small grey images.

function stats(img, mask) {
  let s = 0, s2 = 0, n = 0;
  for (let i = 0; i < img.length; i++) if (!mask[i]) { s += img[i]; s2 += img[i] * img[i]; n++; }
  const mean = n ? s / n : 0;
  return { mean, std: n ? Math.sqrt(Math.max(1e-6, s2 / n - mean * mean)) : 1 };
}
function normalize(img, mask) {
  const { mean, std } = stats(img, mask);
  const out = new Float32Array(img.length);
  for (let i = 0; i < img.length; i++) out[i] = (img[i] - mean) / std;
  return out;
}
function half(img, mask, w, h) {
  const W = w >> 1, H = h >> 1, out = new Float32Array(W * H), m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 2 * y * w + 2 * x;
    out[y * W + x] = (img[i] + img[i + 1] + img[i + w] + img[i + w + 1]) / 4;
    m[y * W + x] = mask[i] | mask[i + 1] | mask[i + w] | mask[i + w + 1];
  }
  return { img: out, mask: m, w: W, h: H };
}

/** Mean absolute difference between ref(x, y) and cur(x + dx, y + dy) over pixels both can see. */
function score(a, ma, b, mb, w, h, dx, dy) {
  let s = 0, n = 0;
  const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx), y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
  for (let y = y0; y < y1; y++) {
    const ra = y * w, rb = (y + dy) * w + dx;
    for (let x = x0; x < x1; x++) {
      if (ma[ra + x] || mb[rb + x]) continue;
      s += Math.abs(a[ra + x] - b[rb + x]);
      n++;
    }
  }
  return n > (w * h) / 6 ? s / n : Infinity;
}

export function createStabilizer({ search = 12 } = {}) {
  let ref = null;

  function prep(gray, mask, w, h) {
    const img = normalize(gray, mask);
    return { L0: { img, mask, w, h }, L1: half(img, mask, w, h) };
  }

  return {
    get hasReference() { return !!ref; },
    setReference(gray, mask, w, h) { ref = prep(gray, mask, w, h); },
    clear() { ref = null; },
    /** Shift of the table since the reference, in pixels of the given image, plus a 0..1 confidence. */
    track(gray, mask, w, h) {
      if (!ref || ref.L0.w !== w || ref.L0.h !== h) return { dx: 0, dy: 0, confidence: 0 };
      const cur = prep(gray, mask, w, h);
      const A = ref.L1, B = cur.L1;
      let best = Infinity, bx = 0, by = 0;
      const all = [];
      for (let dy = -search; dy <= search; dy++) for (let dx = -search; dx <= search; dx++) {
        const s = score(A.img, A.mask, B.img, B.mask, A.w, A.h, dx, dy);
        if (s < Infinity) all.push(s);
        if (s < best) { best = s; bx = dx; by = dy; }
      }
      if (!all.length) return { dx: 0, dy: 0, confidence: 0 };
      all.sort((p, q) => p - q);
      const median = all[all.length >> 1];
      const confidence = Math.max(0, 1 - best / (median || 1));
      // Refine at full resolution.
      const a = ref.L0, b = cur.L0;
      let fbest = Infinity, fx = 2 * bx, fy = 2 * by;
      for (let dy = 2 * by - 2; dy <= 2 * by + 2; dy++) for (let dx = 2 * bx - 2; dx <= 2 * bx + 2; dx++) {
        const s = score(a.img, a.mask, b.img, b.mask, w, h, dx, dy);
        if (s < fbest) { fbest = s; fx = dx; fy = dy; }
      }
      return { dx: fx, dy: fy, confidence };
    },
  };
}
