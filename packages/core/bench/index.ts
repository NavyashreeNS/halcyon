/**
 * Discrete-event simulation comparing three batching strategies on an identical workload
 * and an identical device model.
 *
 * The point of this harness is to make the central claim falsifiable. "Adaptive batching
 * improves throughput" is marketing; a reproducible simulation that runs the *same* arrival
 * trace through three schedulers and reports p99 latency, SLO attainment and accelerator
 * utilisation for each is evidence. Every source of randomness is seeded, so two runs on
 * two machines produce identical numbers.
 *
 * Run with `npm run bench`.
 */
import { ManualClock } from '../src/clock.js';
import { ContinuousBatcher, Lane, type BatchFlush } from '../src/batching/batcher.js';
import { BatchCostModel } from '../src/batching/cost-model.js';
import { LatencyHistogram } from '../src/stats/histogram.js';

// ---------------------------------------------------------------------------------------
// Device model
// ---------------------------------------------------------------------------------------

/**
 * A single accelerator executing one batch at a time. The affine cost
 * `KERNEL_OVERHEAD_MS + MS_PER_TOKEN × tokens` is what makes batching worthwhile at all:
 * the fixed term is paid once per batch rather than once per request.
 *
 * These constants are in the region measured for a 7–8B parameter decoder on an A10G-class
 * device. The absolute values matter less than their *ratio*, which is what determines how
 * much batching can theoretically recover.
 */
const KERNEL_OVERHEAD_MS = 18;
const MS_PER_TOKEN = 0.022;
const JITTER = 0.08; // ±8% execution-time noise.

const SIM_DURATION_MS = 120_000;
/** Latency budgets per cohort. */
const SLO_MS: Record<Cohort, number> = { urgent: 120, relaxed: 900 };

/**
 * Cohorts exist because real traffic does not share one SLO. An autocomplete call and a
 * nightly summarisation job hit the same fleet with latency budgets an order of magnitude
 * apart, and a scheduler that cannot tell them apart must either punish the batch job or
 * fail the interactive one.
 */
type Cohort = 'urgent' | 'relaxed';

interface SimRequest {
  id: string;
  tokens: number;
  arrivedAt: number;
  deadlineAt: number;
  cohort: Cohort;
}

interface PendingBatch {
  items: SimRequest[];
  tokens: number;
  durationMs: number;
}

interface Result {
  strategy: string;
  completed: number;
  rejected: number;
  /** Requests finished *within their deadline* per second — the only number that pays. */
  goodputPerSec: number;
  p50: number;
  p95: number;
  p99: number;
  urgentSlo: number;
  relaxedSlo: number;
  utilisation: number;
  meanBatchSize: number;
}

/** Deterministic PRNG (mulberry32) — the whole benchmark must be reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds one arrival trace and reuses it across every strategy. Comparing schedulers on
 * different traces would confound the scheduler with the workload.
 */
function buildTrace(arrivalsPerSecond: number, urgentShare: number, seed: number): SimRequest[] {
  const rng = mulberry32(seed);
  const trace: SimRequest[] = [];
  let t = 0;
  let n = 0;
  while (t < SIM_DURATION_MS) {
    // Exponential inter-arrival times => Poisson process.
    t += -Math.log(1 - rng()) * (1000 / arrivalsPerSecond);
    if (t >= SIM_DURATION_MS) break;
    // Log-normal request sizes: most requests are small, a few are very large. This heavy
    // tail is what breaks naive fixed-size batching.
    const magnitude = Math.exp(4.8 + 0.9 * gaussian(rng));
    const tokens = Math.max(16, Math.min(4_096, Math.round(magnitude)));
    const cohort: Cohort = rng() < urgentShare ? 'urgent' : 'relaxed';
    trace.push({
      id: `r${n++}`,
      tokens,
      arrivedAt: t,
      deadlineAt: t + SLO_MS[cohort],
      cohort,
    });
  }
  return trace;
}

function gaussian(rng: () => number): number {
  // Box–Muller.
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface StrategyConfig {
  name: string;
  maxBatchSize: number;
  maxBatchTokens: number;
  lingerMs: number;
  /** When false, deadlines are effectively infinite — the scheduler cannot react to SLOs. */
  deadlineAware: boolean;
}

const STRATEGIES: StrategyConfig[] = [
  {
    name: 'no batching',
    maxBatchSize: 1,
    maxBatchTokens: 1_000_000,
    lingerMs: 0,
    deadlineAware: false,
  },
  {
    name: 'fixed batch (32 / 25ms)',
    maxBatchSize: 32,
    maxBatchTokens: 1_000_000,
    lingerMs: 25,
    deadlineAware: false,
  },
  {
    name: 'halcyon (deadline-aware)',
    maxBatchSize: 32,
    maxBatchTokens: 16_384,
    lingerMs: 25,
    deadlineAware: true,
  },
];

function run(config: StrategyConfig, trace: SimRequest[], seed: number): Result {
  const rng = mulberry32(seed);
  const clock = new ManualClock(0);
  const costModel = new BatchCostModel(KERNEL_OVERHEAD_MS, MS_PER_TOKEN);

  // The device executes exactly one batch at a time and has no queue of its own. Modelling
  // an unbounded downstream queue would be the classic benchmarking mistake: it hides
  // backpressure from the scheduler, so no strategy ever appears to overload and the
  // queue simply relocates somewhere the simulation does not measure.
  let pending: PendingBatch | null = null;
  let deviceBusyUntil = 0;
  let inFlight: PendingBatch | null = null;
  let busyTime = 0;

  const latency = new LatencyHistogram(10, 600_000);
  let completed = 0;
  let rejected = 0;
  let batches = 0;
  let batchedItems = 0;
  // Offered load and satisfied load, tracked per cohort. A request that is shed counts
  // against its cohort's attainment exactly as a request that is served too late does —
  // anything else would let a scheduler score well by simply refusing hard work.
  const offered: Record<Cohort, number> = { urgent: 0, relaxed: 0 };
  const satisfied: Record<Cohort, number> = { urgent: 0, relaxed: 0 };
  for (const request of trace) offered[request.cohort] += 1;

  const batcher = new ContinuousBatcher<SimRequest>({
    maxBatchSize: config.maxBatchSize,
    maxBatchTokens: config.maxBatchTokens,
    // ~2.5s of work at capacity. Every strategy gets the same ceiling, so differences come
    // from *which* requests a scheduler keeps, not from how much room it was given.
    maxQueueDepth: 512,
    lingerMs: config.lingerMs,
    safetyMarginMs: config.deadlineAware ? 4 : 0,
    starvationGuardMs: 250,
    clock,
    costModel,
    canFlush: () => inFlight === null && pending === null,
    pendingWorkMs: () =>
      (inFlight ? Math.max(0, deviceBusyUntil - clock.now()) : 0) + (pending?.durationMs ?? 0),
    onFlush: (batch: BatchFlush<SimRequest>) => {
      const nominal = KERNEL_OVERHEAD_MS + MS_PER_TOKEN * batch.totalTokens;
      const durationMs = nominal * (1 + (rng() * 2 - 1) * JITTER);
      pending = {
        items: batch.items.map((i) => i.payload),
        tokens: batch.totalTokens,
        durationMs,
      };
      batches += 1;
      batchedItems += batch.items.length;
    },
  });

  let cursor = 0;
  for (let now = 0; now <= SIM_DURATION_MS + 20_000; now += 1) {
    // 1. Admit every request that has arrived by this tick.
    while (cursor < trace.length && trace[cursor]!.arrivedAt <= now) {
      const request = trace[cursor]!;
      cursor += 1;
      const result = batcher.enqueue({
        id: request.id,
        payload: request,
        tokens: request.tokens,
        lane: Lane.Interactive,
        // A deadline-unaware scheduler is given an unreachable deadline, which disables
        // every SLO-driven code path and leaves only size and linger to trigger flushes.
        deadlineAt: config.deadlineAware ? request.deadlineAt : now + 3_600_000,
        enqueuedAt: now,
      });
      if (!result.accepted) rejected += 1;
    }

    // 2. Retire the batch currently on the device.
    if (inFlight && now >= deviceBusyUntil) {
      for (const item of inFlight.items) {
        latency.record(now - item.arrivedAt);
        completed += 1;
        if (now <= item.deadlineAt) satisfied[item.cohort] += 1;
      }
      batcher.recordExecution(inFlight.tokens, inFlight.durationMs);
      inFlight = null;
      // Tell the scheduler the accelerator is free so it can dispatch without waiting for
      // its polling tick — this is the pull half of a push/pull scheduler.
      batcher.signalCapacity();
    }

    // 3. Start the next batch if the device is free.
    if (!inFlight && pending) {
      inFlight = pending;
      pending = null;
      deviceBusyUntil = now + inFlight.durationMs;
      busyTime += inFlight.durationMs;
    }

    clock.advance(1);
  }

  const totalSatisfied = satisfied.urgent + satisfied.relaxed;
  return {
    strategy: config.name,
    completed,
    rejected,
    goodputPerSec: (totalSatisfied / SIM_DURATION_MS) * 1000,
    p50: latency.p50,
    p95: latency.p95,
    p99: latency.p99,
    urgentSlo: offered.urgent === 0 ? 1 : satisfied.urgent / offered.urgent,
    relaxedSlo: offered.relaxed === 0 ? 1 : satisfied.relaxed / offered.relaxed,
    utilisation: Math.min(1, busyTime / SIM_DURATION_MS),
    meanBatchSize: batches === 0 ? 0 : batchedItems / batches,
  };
}

function formatTable(results: Result[]): string {
  const header = [
    'strategy',
    'goodput/s',
    'p50 ms',
    'p95 ms',
    'p99 ms',
    'urgent SLO',
    'relaxed SLO',
    'util %',
    'batch',
    'shed',
  ];
  const rows = results.map((r) => [
    r.strategy,
    r.goodputPerSec.toFixed(1),
    r.p50.toFixed(0),
    r.p95.toFixed(0),
    r.p99.toFixed(0),
    `${(r.urgentSlo * 100).toFixed(1)}%`,
    `${(r.relaxedSlo * 100).toFixed(1)}%`,
    (r.utilisation * 100).toFixed(1),
    r.meanBatchSize.toFixed(1),
    String(r.rejected),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ') + ' |';
  const divider = '|-' + widths.map((w) => '-'.repeat(w)).join('-|-') + '-|';
  return [line(header), divider, ...rows.map(line)].join('\n');
}

function main(): void {
  const scenarios = [
    {
      label: 'moderate load, mixed SLOs — 40 req/s, 30% urgent',
      rate: 40,
      urgentShare: 0.3,
    },
    {
      label: 'heavy load, mixed SLOs — 90 req/s, 30% urgent',
      rate: 90,
      urgentShare: 0.3,
    },
    {
      label: 'saturated, mixed SLOs — 200 req/s, 30% urgent',
      rate: 200,
      urgentShare: 0.3,
    },
    {
      // Deliberately past the device's ~219 req/s ceiling. Nothing can serve this trace in
      // full; the only question is which requests a scheduler chooses to sacrifice.
      label: 'overload, mixed SLOs — 260 req/s, 30% urgent',
      rate: 260,
      urgentShare: 0.3,
    },
  ];

  console.log('Halcyon batching benchmark');
  console.log(
    `device: ${KERNEL_OVERHEAD_MS}ms kernel overhead + ${MS_PER_TOKEN}ms/token · ` +
      `SLOs urgent ${SLO_MS.urgent}ms / relaxed ${SLO_MS.relaxed}ms · ` +
      `${SIM_DURATION_MS / 1000}s simulated · seeded, reproducible`,
  );
  console.log(
    'SLO columns are share of *offered* requests met in time, so shedding is not rewarded.\n',
  );

  for (const scenario of scenarios) {
    const trace = buildTrace(scenario.rate, scenario.urgentShare, 0xc0ffee);
    const results = STRATEGIES.map((s, i) => {
      const started = Date.now();
      const result = run(s, trace, 0xbeef + i);
      // Progress goes to stderr so piping stdout still yields clean markdown tables.
      process.stderr.write(`  ${scenario.rate} req/s · ${s.name}: ${Date.now() - started}ms\n`);
      return result;
    });
    console.log(`## ${scenario.label}  (${trace.length} requests)`);
    console.log(formatTable(results));
    console.log();
  }
}

main();
