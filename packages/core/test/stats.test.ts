import { describe, expect, it } from 'vitest';
import { Ewma } from '../src/stats/ewma.js';
import { LatencyHistogram } from '../src/stats/histogram.js';

describe('LatencyHistogram', () => {
  it('is exact for values inside the linear region', () => {
    const h = new LatencyHistogram(8, 100_000);
    for (const v of [0, 1, 17, 128, 255]) h.record(v);
    expect(h.min).toBe(0);
    expect(h.max).toBe(255);
    expect(h.count).toBe(5);
    // Every one of these lands in its own exact bucket, so p100 is exactly the max.
    expect(h.quantile(1)).toBe(255);
  });

  it('keeps quantiles within the documented relative error in the logarithmic region', () => {
    const h = new LatencyHistogram(8, 1_000_000);
    // A realistic long-tailed latency profile: mostly fast, with a decisive tail.
    for (let i = 0; i < 9_900; i++) h.record(20);
    for (let i = 0; i < 100; i++) h.record(5_000);

    expect(h.p50).toBe(20);
    expect(h.p95).toBe(20);
    // p99 sits exactly at the boundary of the tail; either side is correct, but it must be
    // within 0.78% of a true value, not an order of magnitude out.
    const p99 = h.p99;
    expect(p99 === 20 || Math.abs(p99 - 5_000) / 5_000 < 0.008).toBe(true);
    expect(Math.abs(h.quantile(0.999) - 5_000) / 5_000).toBeLessThan(0.008);
  });

  it('tracks a uniform distribution accurately across three orders of magnitude', () => {
    const h = new LatencyHistogram(10, 1_000_000);
    const samples: number[] = [];
    // Deterministic pseudo-random sequence — no reliance on Math.random in tests.
    let seed = 42;
    for (let i = 0; i < 20_000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const value = 1 + (seed % 100_000);
      samples.push(value);
      h.record(value);
    }
    samples.sort((a, b) => a - b);
    const trueP99 = samples[Math.ceil(0.99 * samples.length) - 1]!;
    expect(Math.abs(h.p99 - trueP99) / trueP99).toBeLessThan(0.002);
  });

  it('merges histograms without losing counts', () => {
    const a = new LatencyHistogram(8, 10_000);
    const b = new LatencyHistogram(8, 10_000);
    for (let i = 0; i < 100; i++) a.record(10);
    for (let i = 0; i < 100; i++) b.record(1_000);
    a.merge(b);
    expect(a.count).toBe(200);
    expect(a.min).toBe(10);
    expect(a.max).toBe(1_000);
    expect(a.p50).toBe(10);
  });

  it('refuses to merge incompatible layouts', () => {
    const a = new LatencyHistogram(8, 10_000);
    const b = new LatencyHistogram(10, 10_000);
    expect(() => a.merge(b)).toThrow(/differing layouts/);
  });

  it('returns zero rather than NaN when empty', () => {
    const h = new LatencyHistogram();
    expect(h.p99).toBe(0);
    expect(h.mean).toBe(0);
    expect(h.min).toBe(0);
  });
});

describe('Ewma', () => {
  it('adopts the first sample exactly instead of dragging up from zero', () => {
    const e = new Ewma(1_000);
    expect(e.observe(500, 0)).toBe(500);
  });

  it('weights by elapsed time, not by sample count', () => {
    const fast = new Ewma(1_000);
    const slow = new Ewma(1_000);
    fast.observe(100, 0);
    slow.observe(100, 0);

    // Same second sample, but arriving after very different gaps.
    fast.observe(200, 10); // 10ms later: barely moves.
    slow.observe(200, 5_000); // 5s later: almost fully replaced.

    expect(fast.get()).toBeLessThan(105);
    expect(slow.get()).toBeGreaterThan(199);
  });

  it('decays a stale reading on read without mutating state', () => {
    const e = new Ewma(1_000);
    e.observe(100, 0);
    const decayed = e.get(2_000);
    expect(decayed).toBeLessThan(20);
    // The stored value is untouched — only the projection decayed.
    expect(e.get()).toBe(100);
  });

  it('rejects a non-positive time constant', () => {
    expect(() => new Ewma(0)).toThrow(RangeError);
  });
});
