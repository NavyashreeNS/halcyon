/**
 * Time-decayed exponentially weighted moving average.
 *
 * A plain EWMA (`v = a*x + (1-a)*v`) silently assumes samples arrive at a fixed rate. Load
 * balancers violate that assumption constantly: a replica that stops receiving traffic
 * freezes at its last observed latency and looks artificially good forever. Decaying by
 * *elapsed time* instead of *sample count* fixes that — a stale replica's estimate relaxes
 * back toward the fresh observation as soon as one arrives.
 *
 * The decay factor is `exp(-Δt / τ)`, so `tauMs` is the time constant: after `tauMs` of
 * silence a single new sample carries ~63% of the weight.
 */
export class Ewma {
  private value: number;
  private lastUpdate: number;
  private initialised: boolean;

  constructor(
    private readonly tauMs: number,
    initial = 0,
  ) {
    if (tauMs <= 0) throw new RangeError('Ewma: tauMs must be > 0');
    this.value = initial;
    this.lastUpdate = 0;
    this.initialised = false;
  }

  /** Folds in a new observation taken at time `now`. */
  observe(sample: number, now: number): number {
    if (!this.initialised) {
      this.value = sample;
      this.lastUpdate = now;
      this.initialised = true;
      return this.value;
    }
    const elapsed = Math.max(0, now - this.lastUpdate);
    const weight = Math.exp(-elapsed / this.tauMs);
    this.value = this.value * weight + sample * (1 - weight);
    this.lastUpdate = now;
    return this.value;
  }

  /**
   * Current estimate. `now` is optional: when supplied, the returned value is decayed to
   * that instant *without* mutating state, which is what a router wants when scoring a
   * replica that has been idle since its last sample.
   */
  get(now?: number): number {
    if (now === undefined || !this.initialised) return this.value;
    const elapsed = Math.max(0, now - this.lastUpdate);
    return this.value * Math.exp(-elapsed / this.tauMs);
  }

  get hasSamples(): boolean {
    return this.initialised;
  }

  reset(): void {
    this.value = 0;
    this.lastUpdate = 0;
    this.initialised = false;
  }
}
