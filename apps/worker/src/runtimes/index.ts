import { createHash } from 'node:crypto';

/**
 * The runtime abstraction.
 *
 * Halcyon's scheduling, routing and rollout logic is entirely independent of what actually
 * runs the model — it only needs to know how long a batch took and what came back. Keeping
 * that behind a two-method interface is what makes the control plane portable across
 * vLLM, TensorRT-LLM, ONNX Runtime or a bare PyTorch process: each is an adapter, and none
 * of them can reach into the scheduler.
 *
 * The simulated runtime shipped here is not a stub standing in for missing work. It is a
 * deliberately *calibrated* device model, so the whole system — batching, backpressure,
 * hedging, canary analysis — can be exercised end to end on a laptop with no GPU, and so
 * failure modes can be injected on demand rather than waited for.
 */
export interface ExecutionItem {
  requestId: string;
  input: string;
  maxOutputTokens: number;
}

export interface ExecutionResult {
  requestId: string;
  output: string;
  promptTokens: number;
  completionTokens: number;
}

export interface ModelRuntime {
  readonly name: string;
  execute(items: ExecutionItem[]): Promise<ExecutionResult[]>;
}

export interface SimulatedRuntimeOptions {
  modelId: string;
  version: string;
  /** Fixed per-batch cost: kernel launches, weight paging, sampler setup. */
  kernelOverheadMs?: number;
  /** Marginal cost per generated token. */
  msPerToken?: number;
  /** Execution-time noise as a fraction, applied symmetrically. */
  jitter?: number;
  /** Probability in [0, 1] that a batch fails outright. Drives breaker and canary tests. */
  failureRate?: number;
  /** Multiplier applied to this replica's speed. Below 1 makes it a straggler. */
  speedFactor?: number;
  seed?: number;
}

/** Deterministic PRNG so a given seed reproduces a given run exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimulatedRuntime implements ModelRuntime {
  readonly name: string;
  private readonly rng: () => number;
  private readonly options: Required<SimulatedRuntimeOptions>;

  constructor(options: SimulatedRuntimeOptions) {
    this.options = {
      kernelOverheadMs: 18,
      msPerToken: 0.022,
      jitter: 0.08,
      failureRate: 0,
      speedFactor: 1,
      seed: 0x5eed,
      ...options,
    };
    this.name = `simulated:${options.modelId}@${options.version}`;
    this.rng = mulberry32(this.options.seed);
  }

  async execute(items: ExecutionItem[]): Promise<ExecutionResult[]> {
    const totalTokens = items.reduce((sum, item) => sum + item.maxOutputTokens, 0);
    const nominal =
      (this.options.kernelOverheadMs + this.options.msPerToken * totalTokens) /
      this.options.speedFactor;
    const durationMs = nominal * (1 + (this.rng() * 2 - 1) * this.options.jitter);

    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(durationMs))));

    if (this.options.failureRate > 0 && this.rng() < this.options.failureRate) {
      throw new Error(`Simulated execution failure on ${this.name}`);
    }

    return items.map((item) => {
      // The "output" is a deterministic function of the input and the model version, so a
      // canary genuinely produces different bytes from its baseline — which is what makes
      // an end-to-end rollout demo meaningful rather than cosmetic.
      const fingerprint = createHash('sha256')
        .update(`${this.options.version}:${item.input}`)
        .digest('hex')
        .slice(0, 16);
      const completionTokens = Math.max(
        1,
        Math.round(item.maxOutputTokens * (0.4 + this.rng() * 0.6)),
      );
      return {
        requestId: item.requestId,
        output: `[${this.options.modelId}@${this.options.version}] ${fingerprint}`,
        promptTokens: estimateTokens(item.input),
        completionTokens,
      };
    });
  }
}

/** Rough token estimate: ~4 characters per token, the usual heuristic for English text. */
const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));
