// One Euro filter (Casiez et al.): smooths heavily when a value is still and
// lightly when it moves fast, so landmarks stop jittering without adding lag to taps.

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  constructor({ minCutoff = 1.2, beta = 10, dCutoff = 1 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.x = null; this.dx = 0; this.t = null;
  }
  filter(value, t) {
    if (this.x === null) { this.x = value; this.t = t; return value; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** Smooths whole hands: one filter per landmark coordinate, per hand id. */
export function createHandSmoother(opts) {
  const hands = new Map(); // id -> { filters, seen }
  return {
    smooth(list, t) {
      const out = list.map((hand) => {
        let s = hands.get(hand.id);
        if (!s) { s = { filters: hand.landmarks.map(() => [new OneEuro(opts), new OneEuro(opts), new OneEuro(opts)]) }; hands.set(hand.id, s); }
        s.seen = t;
        return {
          id: hand.id,
          landmarks: hand.landmarks.map((p, i) => ({
            x: s.filters[i][0].filter(p.x, t),
            y: s.filters[i][1].filter(p.y, t),
            z: s.filters[i][2].filter(p.z ?? 0, t),
          })),
        };
      });
      for (const [id, s] of hands) if (t - s.seen > 0.3) hands.delete(id); // hand left: start fresh
      return out;
    },
    reset() { hands.clear(); },
  };
}
