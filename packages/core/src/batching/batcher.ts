import type { CancelHandle, Clock } from '../clock.js';
import { LatencyHistogram } from '../stats/histogram.js';
import { BatchCostModel } from './cost-model.js';

/** Interactive work is latency-critical; bulk work is throughput-critical. */
export const Lane = {
  Interactive: 'interactive',
  Bulk: 'bulk',
} as const;
export type Lane = (typeof Lane)[keyof typeof Lane];

export interface BatchItem<T> {
  readonly id: string;
  readonly payload: T;
  /** Units of work — tokens for an LLM, pixels for a vision model. Drives the cost model. */
  readonly tokens: number;
  readonly lane: Lane;
  /** Absolute time by which this request must have *completed* to satisfy its SLO. */
  readonly deadlineAt: number;
  readonly enqueuedAt: number;
}

export type FlushReason =
  /** Batch hit `maxBatchSize` or `maxBatchTokens`; waiting longer buys nothing. */
  | 'saturated'
  /** Waiting one more millisecond would blow the tightest deadline in the queue. */
  | 'deadline'
  /** `lingerMs` elapsed — the ceiling on deliberate waiting. */
  | 'linger'
  /** Explicit `drain()`, e.g. during graceful shutdown. */
  | 'drain';

export interface BatchFlush<T> {
  readonly items: BatchItem<T>[];
  readonly reason: FlushReason;
  readonly totalTokens: number;
  readonly flushedAt: number;
}

export interface BatcherOptions<T> {
  /** Hard ceiling on requests per batch — usually a property of the model's compiled graph. */
  maxBatchSize: number;
  /** Hard ceiling on work units per batch — usually a property of device memory. */
  maxBatchTokens: number;
  /** Backpressure threshold. Beyond this, `enqueue` rejects rather than growing unboundedly. */
  maxQueueDepth: number;
  /** Upper bound on how long the scheduler will deliberately wait to grow a batch. */
  lingerMs: number;
  /** Headroom reserved for dispatch, network and deserialisation on top of predicted compute. */
  safetyMarginMs: number;
  /** A bulk-lane item waiting this long is promoted ahead of interactive work. */
  starvationGuardMs: number;
  clock: Clock;
  costModel?: BatchCostModel;
  /**
   * Backpressure gate. When supplied and returning false, the scheduler holds the batch
   * rather than dispatching it — an accelerator executes one batch at a time, and flushing
   * into an unbounded downstream queue simply relocates the queue somewhere it cannot be
   * reasoned about. Pair with {@link ContinuousBatcher.signalCapacity} so the scheduler is
   * woken the moment the device frees up instead of polling for it.
   */
  canFlush?: () => boolean;
  /**
   * Estimated milliseconds of already-dispatched work that has not yet completed.
   *
   * Without this the scheduler reasons only about its own queue and is blind to the batch
   * currently occupying the accelerator. That blind spot is systematic, not random: every
   * feasibility estimate is short by roughly one batch execution, so under load the queue
   * settles at exactly the depth where admitted requests miss their deadline by about the
   * duration of one batch. Supplying it makes the admission decision honest.
   */
  pendingWorkMs?: () => number;
  onFlush: (batch: BatchFlush<T>) => void;
  /**
   * Called for items evicted because their deadline passed while they were still queued.
   *
   * Without this the queue is a place requests can disappear into. If downstream capacity
   * never returns — every replica draining, a fleet-wide outage — `canFlush` stays false and
   * queued work waits forever, holding the caller's connection open long past the point the
   * answer could be useful. Expiry makes the failure explicit and bounded by the deadline the
   * caller already stated.
   */
  onExpire?: (item: BatchItem<T>) => void;
}

/**
 * Shortest wait the scheduler will ever arm a timer for. Below this, waiting is not
 * schedulable and the batcher flushes instead. See `reconsider` for why this matters.
 */
const MIN_TIMER_QUANTUM_MS = 1;

/**
 * How often to re-check for downstream capacity while it is unavailable. `signalCapacity()`
 * is the primary wake path; this bounds how long a missed signal can stall the queue.
 */
const BUSY_POLL_MS = 5;

export type EnqueueResult =
  | { accepted: true; queueDepth: number }
  | { accepted: false; reason: 'queue_full' | 'deadline_unreachable'; queueDepth: number };

/**
 * Deadline-aware continuous batcher.
 *
 * The tension this resolves is the whole reason inference serving is hard. Executing every
 * request the instant it arrives keeps latency minimal but leaves the accelerator idle
 * between kernel launches — in practice 60–80% of a GPU's capacity evaporates. Waiting to
 * fill a fixed-size batch recovers that throughput but adds unbounded queueing delay, and
 * a fixed timeout is a guess that is wrong at every load level except the one it was tuned
 * for.
 *
 * Halcyon instead treats it as a scheduling problem with an explicit feasibility test.
 * Requests are ordered earliest-deadline-first, and on every arrival the batcher asks:
 * *given the fitted cost model, is there still slack before the tightest deadline in the
 * queue?* If yes, keep accumulating — the batch is free to grow. If no, flush immediately,
 * regardless of how small the batch is. Latency targets are therefore respected by
 * construction rather than by tuning, and batch size becomes an emergent property of load:
 * large when traffic is heavy and deadlines are loose, size-of-one when a lone urgent
 * request arrives on an idle system.
 *
 * The two lanes exist because a nightly embedding backfill and a user-facing completion
 * should not compete on equal terms. Bulk work yields to interactive work, but ages into
 * the fast lane after `starvationGuardMs` so it cannot be postponed forever.
 */
export class ContinuousBatcher<T> {
  private readonly interactive: BatchItem<T>[] = [];
  private readonly bulk: BatchItem<T>[] = [];
  private readonly costModel: BatchCostModel;
  private timer: CancelHandle | null = null;
  private queuedTokens = 0;
  private closed = false;
  private oldest: number | null = null;

  // Observability — surfaced verbatim on /metrics and the control-plane dashboard.
  private readonly waitHistogram = new LatencyHistogram(8, 60_000);
  private readonly batchSizeHistogram = new LatencyHistogram(8, 4_096);
  private readonly flushReasons: Record<FlushReason, number> = {
    saturated: 0,
    deadline: 0,
    linger: 0,
    drain: 0,
  };
  private batchesFlushed = 0;
  private itemsFlushed = 0;
  private itemsRejected = 0;
  private itemsExpired = 0;

  constructor(private readonly options: BatcherOptions<T>) {
    if (options.maxBatchSize < 1) throw new RangeError('maxBatchSize must be >= 1');
    if (options.maxBatchTokens < 1) throw new RangeError('maxBatchTokens must be >= 1');
    if (options.maxQueueDepth < 1) throw new RangeError('maxQueueDepth must be >= 1');
    this.costModel = options.costModel ?? new BatchCostModel();
  }

  get depth(): number {
    return this.interactive.length + this.bulk.length;
  }

  get tokens(): number {
    return this.queuedTokens;
  }

  get model(): BatchCostModel {
    return this.costModel;
  }

  /**
   * Offers an item to the scheduler. Rejection is a feature, not a failure: shedding a
   * request the system provably cannot serve in time is strictly better than accepting it,
   * burning GPU seconds on it, and returning a response nobody is still waiting for.
   */
  enqueue(item: BatchItem<T>): EnqueueResult {
    if (this.closed) {
      return { accepted: false, reason: 'queue_full', queueDepth: this.depth };
    }
    if (this.depth >= this.options.maxQueueDepth) {
      this.itemsRejected++;
      return { accepted: false, reason: 'queue_full', queueDepth: this.depth };
    }

    // Feasibility check. This is the single most valuable thing the scheduler does under
    // overload: it accounts for the work already queued *ahead* of this request under EDF,
    // not merely the cost of running it alone. A request whose deadline cannot be met even
    // in the best case is rejected now, in microseconds, instead of consuming a GPU slot
    // and then returning a response nobody is still waiting for. Shedding early is what
    // keeps goodput from collapsing when offered load exceeds capacity.
    const now = this.options.clock.now();
    const ahead = this.workAheadOf(item.deadlineAt, now);
    const projectedCost =
      this.estimateDrainMs(ahead.tokens + item.tokens, ahead.count + 1) + this.pendingWork();
    if (item.deadlineAt - now < projectedCost + this.options.safetyMarginMs) {
      this.itemsRejected++;
      return { accepted: false, reason: 'deadline_unreachable', queueDepth: this.depth };
    }

    const lane = item.lane === Lane.Bulk ? this.bulk : this.interactive;
    insertByDeadline(lane, item);
    this.queuedTokens += item.tokens;
    if (this.oldest === null) this.oldest = item.enqueuedAt;

    this.reconsider();
    return { accepted: true, queueDepth: this.depth };
  }

  /** Feeds an executed batch's real duration back into the cost model. */
  recordExecution(tokens: number, durationMs: number): void {
    this.costModel.observe(tokens, durationMs);
  }

  /**
   * Called by the executor when it becomes able to accept another batch. Lets the scheduler
   * dispatch immediately rather than waiting for its next polling tick.
   */
  signalCapacity(): void {
    if (this.closed) return;
    this.reconsider();
  }

  /**
   * Total queued work that must clear before `deadlineAt` can be served, under EDF ordering.
   * Both lanes are deadline-sorted, so the scan stops at the first item scheduled after the
   * one being tested — for the urgent arrivals that matter most this examines only a handful
   * of entries, not the whole queue.
   */
  private workAheadOf(deadlineAt: number, now: number): { tokens: number; count: number } {
    let tokens = 0;
    let count = 0;
    for (const lane of [this.interactive, this.bulk]) {
      for (const queued of lane) {
        if (queued.deadlineAt > deadlineAt) break;
        tokens += queued.tokens;
        count += 1;
      }
    }
    void now;
    return { tokens, count };
  }

  /**
   * Wall-clock estimate for draining `tokens` of work spread over `count` requests. Work is
   * executed in batches bounded by both ceilings, so the fixed per-batch cost is paid once
   * per batch — ignoring that term is what makes naive estimators wildly optimistic exactly
   * when the queue is deep.
   */
  private estimateDrainMs(tokens: number, count: number): number {
    const batches = Math.max(
      1,
      Math.ceil(count / this.options.maxBatchSize),
      Math.ceil(tokens / this.options.maxBatchTokens),
    );
    return batches * this.costModel.intercept + this.costModel.slope * tokens;
  }

  /**
   * Flushes everything currently queued, ignoring deadline and linger logic but still
   * chunking into `maxBatchSize` batches — a worker cannot accept an unbounded one.
   * Used on graceful shutdown so in-flight work is not dropped.
   */
  drain(): void {
    while (this.depth > 0) {
      this.flush('drain');
    }
    this.disarm();
  }

  /** Stops accepting work. Any queued items are flushed first. */
  close(): void {
    this.drain();
    this.closed = true;
  }

  /**
   * The scheduling decision. Called on every arrival and whenever the armed timer fires.
   */
  private reconsider(): void {
    if (this.depth === 0) {
      this.disarm();
      return;
    }
    let now = this.options.clock.now();

    // Evict anything whose deadline has already passed. Executing it would burn accelerator
    // time on a response nobody is waiting for, and holding it would be worse still.
    if (this.expireOverdue(now) && this.depth === 0) {
      this.disarm();
      return;
    }
    now = this.options.clock.now();

    // Downstream is busy. Hold the batch and re-check shortly; `signalCapacity()` normally
    // wakes us first, so this poll is a safety net rather than the primary path.
    if (this.options.canFlush && !this.options.canFlush()) {
      // Wake at whichever comes first: the next poll, or the earliest deadline in the queue.
      // Without the second term, a queue with no downstream capacity would poll every
      // millisecond and still never notice that its contents had gone stale.
      const earliest = this.earliestDeadline();
      const untilExpiry = earliest === null ? Number.POSITIVE_INFINITY : earliest - now;
      this.arm(Math.max(MIN_TIMER_QUANTUM_MS, Math.min(BUSY_POLL_MS, untilExpiry)));
      return;
    }

    // 1. Saturation — the batch is as large as the device will take. `capped` covers the
    // case where the projection was truncated by a ceiling with work still queued behind
    // it: waiting cannot grow *this* batch any further, so flushing now is strictly better.
    const projected = this.projectBatch(now);
    if (
      projected.capped ||
      projected.size >= this.options.maxBatchSize ||
      projected.tokens >= this.options.maxBatchTokens
    ) {
      this.flush('saturated');
      return;
    }

    // 2. Feasibility — how much slack remains before the tightest deadline?
    const slack = this.slackMs(now, projected.tokens);
    if (slack <= 0) {
      this.flush('deadline');
      return;
    }

    // 3. Linger ceiling — bound the wait even when every deadline is generous.
    const oldest = this.oldestEnqueuedAt();
    const lingerRemaining = this.options.lingerMs - (now - oldest);
    if (lingerRemaining <= 0) {
      this.flush('linger');
      return;
    }

    // Nothing forces a flush yet. Wake up at whichever constraint binds first.
    //
    // The quantum floor is load-bearing, not a micro-optimisation. As the system approaches
    // saturation, slack converges towards zero from above, and without a floor the scheduler
    // arms a timer a fraction of a millisecond out, wakes, recomputes an equally tiny slack,
    // and re-arms — a busy-spin that burns the event loop precisely when it is scarcest.
    // No runtime can honour a sub-millisecond timer anyway, so any slack below one tick is
    // slack we cannot spend: flush and take the batch we have.
    const wait = Math.min(slack, lingerRemaining);
    if (wait < MIN_TIMER_QUANTUM_MS) {
      this.flush(slack <= lingerRemaining ? 'deadline' : 'linger');
      return;
    }
    this.arm(wait);
  }

  /**
   * Milliseconds of headroom before the earliest deadline in the queue would be missed if
   * we executed a batch of `tokens` work units starting now.
   */
  private slackMs(now: number, tokens: number): number {
    const earliest = this.earliestDeadline();
    if (earliest === null) return Number.POSITIVE_INFINITY;
    const executionCost =
      this.costModel.predict(tokens) + this.options.safetyMarginMs + this.pendingWork();
    return earliest - now - executionCost;
  }

  /** Downstream work already dispatched and not yet complete; zero if the caller cannot say. */
  private pendingWork(): number {
    return Math.max(0, this.options.pendingWorkMs?.() ?? 0);
  }

  /**
   * Removes every queued item whose deadline has passed, reporting each via `onExpire`.
   * Returns true if anything was evicted.
   */
  private expireOverdue(now: number): boolean {
    let expired = 0;
    for (const lane of [this.interactive, this.bulk]) {
      // Lanes are deadline-ordered, so overdue items are always a prefix.
      while (lane.length > 0 && lane[0]!.deadlineAt <= now) {
        const item = lane.shift()!;
        this.queuedTokens -= item.tokens;
        this.itemsExpired += 1;
        expired += 1;
        this.options.onExpire?.(item);
      }
    }
    if (expired > 0) this.recomputeOldest();
    return expired > 0;
  }

  /** Cheap O(1) minimum: each lane is already deadline-ordered, so scan only the heads. */
  private earliestDeadline(): number | null {
    const a = this.interactive[0]?.deadlineAt;
    const b = this.bulk[0]?.deadlineAt;
    if (a === undefined) return b ?? null;
    if (b === undefined) return a;
    return Math.min(a, b);
  }

  /**
   * Arrival times are non-decreasing, so the oldest queued item is simply the
   * earliest-arriving one still present. Lanes are ordered by *deadline*, not arrival, so
   * this cannot be read off a head — it is maintained incrementally on insert and
   * recomputed once per flush (O(remaining), bounded by `maxQueueDepth`).
   */
  private oldestEnqueuedAt(): number {
    return this.oldest ?? this.options.clock.now();
  }

  private recomputeOldest(): void {
    if (this.depth === 0) {
      this.oldest = null;
      return;
    }
    let min = Number.POSITIVE_INFINITY;
    for (const item of this.interactive) if (item.enqueuedAt < min) min = item.enqueuedAt;
    for (const item of this.bulk) if (item.enqueuedAt < min) min = item.enqueuedAt;
    this.oldest = min;
  }

  /**
   * Size and token count the next batch would have, without mutating the queues.
   * `capped` reports that a ceiling — not an empty queue — ended the projection.
   */
  private projectBatch(now: number): { size: number; tokens: number; capped: boolean } {
    let size = 0;
    let tokens = 0;
    let i = 0;
    let j = 0;
    for (;;) {
      const next = this.peekNext(now, i, j);
      if (!next) return { size, tokens, capped: false };
      if (size + 1 > this.options.maxBatchSize) return { size, tokens, capped: true };
      // A single item larger than the whole token ceiling still goes out alone — rejecting
      // it here would strand it in the queue forever.
      if (size > 0 && tokens + next.item.tokens > this.options.maxBatchTokens) {
        return { size, tokens, capped: true };
      }
      size += 1;
      tokens += next.item.tokens;
      if (next.lane === Lane.Bulk) j++;
      else i++;
    }
  }

  /**
   * Selection policy across the two lanes. Interactive work wins by default; a bulk item
   * that has waited past the starvation guard is promoted ahead of it.
   */
  private peekNext(
    now: number,
    interactiveIdx: number,
    bulkIdx: number,
  ): { item: BatchItem<T>; lane: Lane } | null {
    const head = this.interactive[interactiveIdx];
    const bulkHead = this.bulk[bulkIdx];
    if (bulkHead && now - bulkHead.enqueuedAt >= this.options.starvationGuardMs) {
      return { item: bulkHead, lane: Lane.Bulk };
    }
    if (head) return { item: head, lane: Lane.Interactive };
    if (bulkHead) return { item: bulkHead, lane: Lane.Bulk };
    return null;
  }

  private flush(reason: FlushReason): void {
    this.disarm();
    const now = this.options.clock.now();
    const items: BatchItem<T>[] = [];
    let tokens = 0;

    for (;;) {
      const next = this.peekNext(now, 0, 0);
      if (!next) break;
      if (reason !== 'drain') {
        if (items.length >= this.options.maxBatchSize) break;
        if (items.length > 0 && tokens + next.item.tokens > this.options.maxBatchTokens) break;
      }
      const lane = next.lane === Lane.Bulk ? this.bulk : this.interactive;
      lane.shift();
      items.push(next.item);
      tokens += next.item.tokens;
      this.queuedTokens -= next.item.tokens;
      // `drain` deliberately keeps going until the queues are empty.
      if (reason === 'drain' && items.length >= this.options.maxBatchSize) break;
    }

    if (items.length === 0) return;
    this.recomputeOldest();

    this.batchesFlushed++;
    this.itemsFlushed += items.length;
    this.flushReasons[reason]++;
    this.batchSizeHistogram.record(items.length);
    for (const item of items) {
      this.waitHistogram.record(now - item.enqueuedAt);
    }

    this.options.onFlush({ items, reason, totalTokens: tokens, flushedAt: now });

    // Anything left over (a batch-size-capped flush) needs a fresh decision immediately.
    if (this.depth > 0 && reason !== 'drain') {
      this.reconsider();
    }
  }

  private arm(delayMs: number): void {
    this.disarm();
    this.timer = this.options.clock.setTimeout(
      () => {
        this.timer = null;
        this.reconsider();
      },
      Math.max(0, delayMs),
    );
  }

  private disarm(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  snapshot(): BatcherSnapshot {
    return {
      queueDepth: this.depth,
      queuedTokens: this.queuedTokens,
      batchesFlushed: this.batchesFlushed,
      itemsFlushed: this.itemsFlushed,
      itemsRejected: this.itemsRejected,
      itemsExpired: this.itemsExpired,
      meanBatchSize:
        this.batchesFlushed === 0
          ? 0
          : Number((this.itemsFlushed / this.batchesFlushed).toFixed(2)),
      flushReasons: { ...this.flushReasons },
      queueWaitMs: this.waitHistogram.snapshot(),
      batchSize: this.batchSizeHistogram.snapshot(),
      costModel: this.costModel.snapshot(),
    };
  }
}

export interface BatcherSnapshot {
  queueDepth: number;
  queuedTokens: number;
  batchesFlushed: number;
  itemsFlushed: number;
  itemsRejected: number;
  itemsExpired: number;
  meanBatchSize: number;
  flushReasons: Record<FlushReason, number>;
  queueWaitMs: ReturnType<LatencyHistogram['snapshot']>;
  batchSize: ReturnType<LatencyHistogram['snapshot']>;
  costModel: ReturnType<BatchCostModel['snapshot']>;
}

/** Binary-search insertion keeping a lane ordered earliest-deadline-first. */
function insertByDeadline<T>(lane: BatchItem<T>[], item: BatchItem<T>): void {
  let lo = 0;
  let hi = lane.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = lane[mid];
    if (candidate !== undefined && candidate.deadlineAt <= item.deadlineAt) lo = mid + 1;
    else hi = mid;
  }
  lane.splice(lo, 0, item);
}
