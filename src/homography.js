// Perspective mapping between the unit square (keyboard space: u across the
// keys, v from the far/black-key end to the near end) and a quad on screen.
// Quads are [[x,y] x4] in order: top-left, top-right, bottom-right, bottom-left.

/** 3x3 matrix (row-major, 9 numbers) taking (0,0),(1,0),(1,1),(0,1) to the quad's corners. */
export function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function invert(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

export function apply(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}

/** Convenience: forward (keyboard -> screen) and inverse (screen -> keyboard) for a quad. */
export function placement(q) {
  const H = squareToQuad(q);
  const Hi = invert(H);
  return {
    quad: q,
    toScreen: (u, v) => apply(H, u, v),
    toLocal: (x, y) => (Hi ? apply(Hi, x, y) : { x: -1, y: -1 }),
  };
}

// ---------- fitting a homography to matched points ----------

function solve(A, b) {
  // Gaussian elimination with partial pivoting; A is n x n (array of rows).
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

const mul = (A, B) => {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
};
export { mul as multiply };

function normalizer(pts) {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p.x, 0) / n, cy = pts.reduce((s, p) => s + p.y, 0) / n;
  const d = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / n || 1;
  const k = Math.SQRT2 / d;
  return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1];
}

/** Least-squares homography taking src[i] to dst[i] (4 or more pairs of {x, y}). */
export function fitHomography(src, dst) {
  if (src.length < 4) return null;
  const Ts = normalizer(src), Td = normalizer(dst);
  const s = src.map((p) => apply(Ts, p.x, p.y)), d = dst.map((p) => apply(Td, p.x, p.y));
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < s.length; i++) {
    const { x, y } = s[i], { x: u, y: v } = d[i];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(AtA, Atb);
  if (!h) return null;
  const Hn = [...h, 1];
  const TdInv = invert(Td);
  if (!TdInv) return null;
  const H = mul(TdInv, mul(Hn, Ts));
  return H.map((v) => v / H[8]);
}

/** Robust fit: tries random 4-point sets, keeps the one most points agree with, then refits on those. */
export function ransacHomography(src, dst, { iterations = 150, threshold = 2.5, rng = Math.random } = {}) {
  const n = src.length;
  if (n < 4) return null;
  let best = null, bestCount = 0;
  const err = (H, i) => { const p = apply(H, src[i].x, src[i].y); return Math.hypot(p.x - dst[i].x, p.y - dst[i].y); };
  for (let it = 0; it < iterations; it++) {
    const idx = new Set();
    while (idx.size < 4) idx.add(Math.floor(rng() * n));
    const pick = [...idx];
    const H = fitHomography(pick.map((i) => src[i]), pick.map((i) => dst[i]));
    if (!H) continue;
    let count = 0;
    for (let i = 0; i < n; i++) if (err(H, i) < threshold) count++;
    if (count > bestCount) { bestCount = count; best = H; if (count > n * 0.9) break; }
  }
  if (!best) return null;
  const inl = [];
  for (let i = 0; i < n; i++) if (err(best, i) < threshold) inl.push(i);
  const H = fitHomography(inl.map((i) => src[i]), inl.map((i) => dst[i])) || best;
  return { H, inliers: inl.length };
}
