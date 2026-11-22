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
  const data = new Map(); // handId -> { rest: [5][samples][4], tap: [5][samples][4] }
  return {
    /** phase 'rest': hand still on the table; 'tap': tapping each finger. */
    add(hands, phase = 'tap') {
      for (const hand of hands) {
        if (!data.has(hand.id)) data.set(hand.id, { rest: [[], [], [], [], []], tap: [[], [], [], [], []] });
        const size = handSize(hand.landmarks);
        const per = data.get(hand.id)[phase];
        for (let f = 0; f < 5; f++) per[f].push(featuresOf(hand.landmarks, f, size));
      }
    },
    get samples() { let n = 0; for (const d of data.values()) n = Math.max(n, d.tap[1].length); return n; },
    result() { return computeCalibration(data); },
  };
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
const meanOf = (rows) => {
  const m = new Array(4).fill(0);
  rows.forEach((r) => r.forEach((v, j) => (m[j] += v / rows.length)));
  return m;
};

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
 * @param data Map handId -> { rest, tap } (or, older form, handId -> tap samples)
 * @returns {{ hands: Object<handId, {w, scale, rest, taps, restWobble}>, any } | null}
 */
export function computeCalibration(data) {
  const hands = {};
  for (const [id, entry] of data) {
    const tap = Array.isArray(entry) ? entry : entry.tap;
    const rest = Array.isArray(entry) ? null : entry.rest;
    if (tap[1].length < 20) continue;
    const haveRest = rest && rest[1].length >= 8;
    // Displacements: from the resting position when we know it, else from each finger's mean.
    const origin = tap.map((rows, f) => (haveRest ? meanOf(rest[f]) : meanOf(rows)));
    const disp = tap.map((rows, f) => rows.map((r) => r.map((v, j) => v - origin[f][j])));
    const D = 4, cov = Array.from({ length: D }, () => new Array(D).fill(0));
    let n = 0;
    for (let f = 1; f < 5; f++) for (const r of disp[f]) {
      for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) cov[i][j] += r[i] * r[j];
      n++;
    }
    if (!n) continue;
    cov.forEach((row) => row.forEach((_, j) => (row[j] /= n)));
    let w = principal(cov);
    const proj = (rows) => rows.map((r) => r.reduce((s, v, j) => s + v * w[j], 0));

    // Orient so "lifted" is positive.
    if (haveRest) {
      // Taps move away from the resting position: their average displacement is positive.
      let m = 0, k = 0;
      for (let f = 1; f < 5; f++) for (const v of proj(disp[f])) { m += v; k++; }
      if (m < 0) w = w.map((x) => -x);
    } else {
      // No resting position: taps are short excursions, so rest is the crowded end.
      let skew = 0;
      for (let f = 1; f < 5; f++) {
        const p = proj(disp[f]).sort((a, b) => a - b);
        const med = quantile(p, 0.5);
        skew += (quantile(p, 0.95) - med) - (med - quantile(p, 0.05));
      }
      if (skew < 0) w = w.map((x) => -x);
    }

    const ranges = [], taps = [];
    for (let f = 0; f < 5; f++) {
      const p = proj(disp[f]);
      const s = [...p].sort((a, b) => a - b);
      const lo = haveRest ? 0 : quantile(s, 0.1), hi = quantile(s, 0.95);
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
    const scale = ranges.map((r) => (r >= Math.max(MIN_TAP, typical * 0.4) ? r : typical));
    // Resting height of each finger in calibrated units (where its table level starts).
    const restLevel = origin.map((o, f) => o.reduce((s, v, j) => s + v * w[j], 0) / scale[f]);
    // How much the hand moved while it was meant to be still, relative to a tap.
    let restWobble = 0;
    if (haveRest) for (let f = 1; f < 5; f++) {
      const p = rest[f].map((r) => r.reduce((s, v, j) => s + (v - origin[f][j]) * w[j], 0) / scale[f]).sort((a, b) => a - b);
      restWobble = Math.max(restWobble, quantile(p, 0.95) - quantile(p, 0.05));
    }
    hands[id] = { w, scale, taps, rest: haveRest ? restLevel : null, restWobble };
  }
  const list = Object.values(hands);
  if (!list.length) return null;
  const w = [0, 1, 2, 3].map((j) => list.reduce((s, h) => s + h.w[j], 0) / list.length);
  const wn = Math.hypot(...w) || 1;
  const scale = [0, 1, 2, 3, 4].map((f) => list.reduce((s, h) => s + h.scale[f], 0) / list.length);
  return { hands, any: { w: w.map((x) => x / wn), scale, taps: [0, 0, 0, 0, 0], rest: null, restWobble: 0 } };
}

/** Calibrated height of finger f: about 0 resting, about 1 at the top of a typical tap (before the table level is subtracted). */
export function calibratedHeight(cal, handId, lm, f, size) {
  const c = cal.hands[handId] || cal.any;
  const x = featuresOf(lm, f, size);
  return x.reduce((s, v, j) => s + v * c.w[j], 0) / c.scale[f];
}

/** Resting level for a finger from calibration, or null. */
export function calibratedRest(cal, handId, f) {
  const c = cal?.hands?.[handId];
  return c?.rest ? c.rest[f] : null;
}
