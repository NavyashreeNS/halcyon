/**
 * Every time-dependent component in Halcyon takes a `Clock` rather than reaching for
 * `Date.now()`. Scheduling bugs are notoriously hard to reproduce when they depend on
 * wall-clock timing, so the entire control plane is written against an injectable clock
 * and the test suite drives it deterministically via {@link ManualClock}.
 */
export interface Clock {
  /** Monotonic-ish milliseconds. Only differences between readings are meaningful. */
  now(): number;
  /** Schedules `fn` to run after `delayMs`; returns a cancel handle. */
  setTimeout(fn: () => void, delayMs: number): CancelHandle;
}

export interface CancelHandle {
  cancel(): void;
}

const NOOP_HANDLE: CancelHandle = { cancel() {} };

/** Production clock, backed by `performance.now()` for monotonicity. */
export class SystemClock implements Clock {
  private readonly origin = Date.now() - Math.round(performance.now());

  now(): number {
    return this.origin + performance.now();
  }

  setTimeout(fn: () => void, delayMs: number): CancelHandle {
    const id = setTimeout(fn, Math.max(0, delayMs));
    // Timers must never keep a worker process alive on their own.
    if (typeof id === 'object' && id !== null && 'unref' in id) {
      (id as { unref(): void }).unref();
    }
    return {
      cancel() {
        clearTimeout(id);
      },
    };
  }
}

interface ScheduledTask {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/**
 * A clock whose time only moves when a test tells it to. Timers fire in `(at, id)` order,
 * and timers scheduled *during* an advance still fire within that same advance if their
 * deadline falls inside the window — which is what makes multi-hop scheduling chains
 * (batch flush -> dispatch -> hedge timer) testable without a single `await sleep()`.
 */
export class ManualClock implements Clock {
  private current: number;
  private nextId = 0;
  private tasks: ScheduledTask[] = [];

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, delayMs: number): CancelHandle {
    const task: ScheduledTask = {
      id: this.nextId++,
      at: this.current + Math.max(0, delayMs),
      fn,
      cancelled: false,
    };
    this.tasks.push(task);
    return {
      cancel() {
        task.cancelled = true;
      },
    };
  }

  /** Moves time forward by `deltaMs`, firing every timer whose deadline is crossed. */
  advance(deltaMs: number): void {
    const target = this.current + deltaMs;
    for (;;) {
      const due = this.tasks
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      const next = due[0];
      if (!next) break;
      this.tasks = this.tasks.filter((t) => t !== next);
      this.current = Math.max(this.current, next.at);
      next.fn();
    }
    this.current = target;
    this.tasks = this.tasks.filter((t) => !t.cancelled);
  }

  /** Number of live timers — useful for asserting that components clean up after themselves. */
  get pendingTimers(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }
}

/** Frozen clock for pure-function tests that need a `Clock` but never advance it. */
export const staticClock = (at = 0): Clock => ({
  now: () => at,
  setTimeout: () => NOOP_HANDLE,
});
