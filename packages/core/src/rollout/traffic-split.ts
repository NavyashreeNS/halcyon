/**
 * Deterministic weighted traffic splitting.
 *
 * The naive implementation is `Math.random() < canaryWeight`, and it is wrong in a way that
 * only shows up in production. A single user session makes many requests; independent coin
 * flips send those requests to *different model versions*, so the user sees a conversation
 * whose voice and capabilities change mid-thread, and any per-session metric becomes a
 * blend of both variants — which destroys the very comparison the canary exists to make.
 *
 * Hashing a stable key (session id, user id, conversation id) instead makes assignment
 * sticky for free, with no shared state between gateway replicas: every instance computes
 * the same answer from the same key. Ramping the weight up only ever *adds* keys to the
 * canary bucket, so users already on the canary stay there as the rollout progresses.
 */
export interface Variant {
  readonly version: string;
  /** Share of traffic in [0, 100]. Weights across a split are normalised. */
  readonly weight: number;
}

/** FNV-1a, 32-bit. Small, fast, no dependencies, and well-distributed for short string keys. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, expressed as shifts to stay in integer range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Maps an arbitrary key onto a uniform value in [0, 1). */
export function hashToUnitInterval(key: string, salt = ''): number {
  return fnv1a32(`${salt}:${key}`) / 0x100000000;
}

export class TrafficSplitter {
  private variants: Variant[];

  /**
   * @param salt Distinguishes independent splits. Without it, two concurrent rollouts would
   *   assign the *same* users to the canary in both, correlating the experiments.
   */
  constructor(
    variants: Variant[],
    private readonly salt = 'halcyon',
  ) {
    this.variants = normalise(variants);
  }

  update(variants: Variant[]): void {
    this.variants = normalise(variants);
  }

  get current(): readonly Variant[] {
    return this.variants;
  }

  /**
   * Resolves `key` to a version. Falls back to the highest-weighted variant if the split
   * is empty, so a misconfigured rollout degrades to "serve something" rather than throwing
   * on the request path.
   */
  select(key: string): string {
    if (this.variants.length === 0) {
      throw new Error('TrafficSplitter: no variants configured');
    }
    const point = hashToUnitInterval(key, this.salt) * 100;
    let cumulative = 0;
    for (const variant of this.variants) {
      cumulative += variant.weight;
      if (point < cumulative) return variant.version;
    }
    return this.variants[this.variants.length - 1]!.version;
  }
}

function normalise(variants: Variant[]): Variant[] {
  const positive = variants.filter((v) => v.weight > 0);
  if (positive.length === 0) return [];
  const total = positive.reduce((sum, v) => sum + v.weight, 0);
  return positive.map((v) => ({ version: v.version, weight: (v.weight / total) * 100 }));
}
