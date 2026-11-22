// Tap calibration: learns, from a few seconds of the player tapping, which way
// their taps show up in the picture for this camera angle, and how big they are.
//
// For every finger we measure a few things relative to its own knuckle (so the
// whole hand moving doesn't matter): how far the fingertip is above/below the
// knuckle in the picture, left/right of it, its depth, and the finger's
// apparent length. During calibration a tap moves these along one main
// direction; we find that direction (principal component), orient it so the
// resting position is the low end, and scale each finger so a typical tap is 1.

export const FEATURE_NAMES = ['up', 'side', 'depth', 'length'];
const TIPS = [4, 8, 12, 16, 20];
const BASES = [2, 5, 9, 13, 17];

/** Feature vector for finger f, in hand-size units. */
export function featuresOf(lm, f, size) {
  const tip = lm[TIPS[f]], base = lm[BASES[f]];
  return [
    (base.y - tip.y) / size,
    (tip.x - base.x) / size,
    -((tip.z ?? 0) - (base.z ?? 0)) / size,
    -Math.hypot(tip.x - base.x, tip.y - base.y) / size,
  ];
}

// Smallest movement (in hand-sizes, along the tap direction) that counts as a tap
// rather than tracking jitter. Real taps move several times this.
export const MIN_TAP = 0.08;

const handSize = (lm) => Math.max(1e-3, Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y));

export function createCalibrator() {
  const data = new Map(); // handId -> [5 fingers][samples][4]
  return {
    add(hands) {
      for (const hand of hands) {
        if (!data.has(hand.id)) data.set(hand.id, [[], [], [], [], []]);
        const size = handSize(hand.landmarks);
        const per = data.get(hand.id);
        for (let f = 0; f < 5; f++) per[f].push(featuresOf(hand.landmarks, f, size));
      }
    },
    get samples() { let n = 0; for (const per of data.values()) n = Math.max(n, per[1].length); return n; },
    result() { return computeCalibration(data); },
  };
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

function principal(cov) {
  // Power iteration on a small symmetric matrix.
  let v = [0.5, 0.5, 0.5, 0.5];
  for (let it = 0; it < 100; it++) {
    const nv = cov.map((row) => row.reduce((s, c, j) => s + c * v[j], 0));
    const n = Math.hypot(...nv) || 1;
    v = nv.map((x) => x / n);
  }
  return v;
}

/**
 * @returns {{ hands: Object<handId, {w, scale: number[], taps: number[]}>, any: {...} } | null}
 */
export function computeCalibration(data) {
  const hands = {};
  for (const [id, per] of data) {
    if (per[1].length < 20) continue;
    // Centre each finger's features on its own mean, pool fingers (not the thumb).
    const D = 4, cov = Array.from({ length: D }, () => new Array(D).fill(0));
    let n = 0;
    const centred = per.map((rows) => {
      const mean = new Array(D).fill(0);
      rows.forEach((r) => r.forEach((v, j) => (mean[j] += v / rows.length)));
      return rows.map((r) => r.map((v, j) => v - mean[j]));
    });
    for (let f = 1; f < 5; f++) for (const r of centred[f]) {
      for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) cov[i][j] += r[i] * r[j];
      n++;
    }
    if (!n) continue;
    cov.forEach((row) => row.forEach((_, j) => (row[j] /= n)));
    let w = principal(cov);

    // Orient: taps are short excursions away from rest, so rest is the crowded end.
    const proj = (rows) => rows.map((r) => r.reduce((s, v, j) => s + v * w[j], 0));
    let skew = 0;
    for (let f = 1; f < 5; f++) {
      const p = proj(centred[f]).sort((a, b) => a - b);
      const med = quantile(p, 0.5);
      skew += (quantile(p, 0.95) - med) - (med - quantile(p, 0.05));
    }
    if (skew < 0) w = w.map((x) => -x);

    // Size of a typical tap for each finger, and how many taps we saw.
    const ranges = [], taps = [];
    for (let f = 0; f < 5; f++) {
      const p = proj(centred[f]);
      const s = [...p].sort((a, b) => a - b);
      const lo = quantile(s, 0.1), hi = quantile(s, 0.97);
      ranges.push(hi - lo);
      let count = 0, up = false;
      if (hi - lo >= MIN_TAP) for (const v of p) {
        if (!up && v > lo + (hi - lo) * 0.6) { up = true; count++; } else if (up && v < lo + (hi - lo) * 0.25) up = false;
      }
      taps.push(count);
    }
    const fingerRanges = ranges.slice(1).sort((a, b) => a - b);
    const typical = quantile(fingerRanges, 0.5);
    if (!(typical >= MIN_TAP)) continue; // only jitter: no clear taps seen
    // A finger that hardly moved gets the hand's typical size instead of its own noise.
    const scale = ranges.map((r) => (r >= Math.max(MIN_TAP, typical * 0.4) ? r : typical));
    hands[id] = { w, scale, taps };
  }
  const list = Object.values(hands);
  if (!list.length) return null;
  // Fallback for a hand that wasn't seen during calibration: average direction and size.
  const w = [0, 1, 2, 3].map((j) => list.reduce((s, h) => s + h.w[j], 0) / list.length);
  const wn = Math.hypot(...w) || 1;
  const scale = [0, 1, 2, 3, 4].map((f) => list.reduce((s, h) => s + h.scale[f], 0) / list.length);
  return { hands, any: { w: w.map((x) => x / wn), scale, taps: [0, 0, 0, 0, 0] } };
}

/** Calibrated height of finger f: about 0 resting, about 1 at the top of a typical tap (before the table level is subtracted). */
export function calibratedHeight(cal, handId, lm, f, size) {
  const c = cal.hands[handId] || cal.any;
  const x = featuresOf(lm, f, size);
  return x.reduce((s, v, j) => s + v * c.w[j], 0) / c.scale[f];
}
