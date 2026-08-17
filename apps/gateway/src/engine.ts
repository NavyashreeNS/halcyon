import { randomUUID } from 'node:crypto';
import {
  AdmissionController,
  CanaryController,
  ContinuousBatcher,
  Lane,
  LatencyHistogram,
  Router,
  SystemClock,
  TrafficSplitter,
  type BatchFlush,
  type Clock,
  type ReplicaSpec,
  type VariantMetrics,
} from '@halcyon/core';
import {
  ERROR_STATUS,
  type BatchExecutionResponse,
  type InferenceRequest,
  type InferenceResponse,
  type WorkerRegistration,
} from '@halcyon/contracts';
import { SpanKind, type Logger, type Span, type Tracer } from '@halcyon/telemetry';
import type { Config } from './config.js';
import type { Metrics } from './metrics.js';

/** A request parked in the batcher, waiting for its batch to be dispatched and executed. */
interface PendingRequest {
  requestId: string;
  tenantId: string;
  input: string;
  maxOutputTokens: number;
  enqueuedAt: number;
  span: Span;
  resolve: (response: InferenceResponse) => void;
  reject: (error: EngineError) => void;
}

export class EngineError extends Error {
  constructor(
    readonly code: keyof typeof ERROR_STATUS,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

/** Rolling per-version counters, reset each analysis window, that drive canary decisions. */
interface VersionWindow {
  requests: number;
  errors: number;
  latency: LatencyHistogram;
}

const modelKey = (modelId: string, version: string): string => `${modelId}@${version}`;

/**
 * The request path.
 *
 * Each of the four algorithms in `@halcyon/core` answers one question, and the engine's job
 * is to ask them in the right order:
 *
 *   1. **Admission** — should we accept this request at all? Asked first, because every
 *      subsequent step costs real resources and a rejected request should cost none.
 *   2. **Rollout** — which model *version* should serve it? Resolved before batching,
 *      because requests for different versions cannot share a batch: they are different
 *      weights on different replicas.
 *   3. **Batching** — coalesce with other requests for the same version, subject to every
 *      participant's deadline.
 *   4. **Routing** — once a batch exists, which replica runs it, and do we hedge?
 *
 * The ordering is not arbitrary. Batching before version resolution would mix versions in
 * one batch; routing before batching would pin a replica before knowing the batch's size,
 * which is precisely the information the load estimate needs.
 */
export class InferenceEngine {
  private readonly clock: Clock = new SystemClock();
  private readonly admission: AdmissionController;
  private readonly router: Router;
  private readonly batchers = new Map<string, ContinuousBatcher<PendingRequest>>();
  private readonly splitters = new Map<string, TrafficSplitter>();
  private readonly rollouts = new Map<string, CanaryController>();
  private readonly windows = new Map<string, VersionWindow>();
  private readonly modelVersions = new Map<string, Set<string>>();
  /** Estimated remaining milliseconds of work already dispatched, per model@version. */
  private readonly inFlightBatches = new Map<string, { count: number; estimatedEndAt: number[] }>();

  private readonly startedAt = Date.now();
  private readonly globalLatency = new LatencyHistogram(8, 600_000);
  private totals = { requests: 0, errors: 0, shed: 0, hedged: 0 };
  private analysisTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly tracer: Tracer,
  ) {
    this.admission = new AdmissionController({
      clock: this.clock,
      defaultQuota: {
        burst: config.defaultTenantBurst,
        ratePerSecond: config.defaultTenantRate,
        priority: config.defaultTenantPriority,
      },
      limiter: {
        initialLimit: config.initialConcurrencyLimit,
        minLimit: config.minConcurrencyLimit,
        maxLimit: config.maxConcurrencyLimit,
      },
    });
    this.router = new Router({
      clock: this.clock,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs,
      maxInflightPerReplica: config.maxInFlightBatchesPerReplica,
    });
  }

  // -------------------------------------------------------------------------------------
  // Worker lifecycle
  // -------------------------------------------------------------------------------------

  registerWorker(registration: WorkerRegistration): void {
    const spec: ReplicaSpec = {
      id: registration.replicaId,
      modelId: registration.modelId,
      version: registration.version,
      address: registration.address,
      weight: registration.weight,
    };
    this.router.register(spec);

    let versions = this.modelVersions.get(registration.modelId);
    if (!versions) {
      versions = new Set();
      this.modelVersions.set(registration.modelId, versions);
    }
    versions.add(registration.version);

    // The first version registered for a model becomes its default traffic target. Without
    // this, a freshly-started fleet would have replicas but no split to route through.
    if (!this.splitters.has(registration.modelId)) {
      this.splitters.set(
        registration.modelId,
        new TrafficSplitter([{ version: registration.version, weight: 100 }], registration.modelId),
      );
    }
    this.ensureBatcher(registration.modelId, registration.version);
    this.logger.info('worker registered', {
      replicaId: registration.replicaId,
      model: registration.modelId,
      version: registration.version,
      accelerator: registration.accelerator,
    });
  }

  heartbeat(replicaId: string): void {
    this.router.heartbeat(replicaId);
  }

  drainWorker(replicaId: string): void {
    this.router.drain(replicaId);
    this.logger.info('worker draining', { replicaId });
  }

  // -------------------------------------------------------------------------------------
  // Request path
  // -------------------------------------------------------------------------------------

  async infer(
    request: InferenceRequest,
    tenantId: string,
    traceparent?: string,
  ): Promise<InferenceResponse> {
    const requestId = randomUUID();
    const span = this.tracer.startSpan('halcyon.infer', SpanKind.Server, traceparent);
    span.setAttributes({
      'halcyon.request_id': requestId,
      'halcyon.tenant_id': tenantId,
      'halcyon.model': request.model,
      'halcyon.lane': request.lane,
      'halcyon.deadline_ms': request.deadlineMs,
    });

    const startedAt = Date.now();
    this.totals.requests += 1;

    try {
      // 1. Admission. Cheapest possible rejection: no version resolution, no queueing.
      const cost = Math.max(1, Math.ceil(request.maxOutputTokens / 64));
      const admitted = this.admission.admit(tenantId, cost);
      if (!admitted.admitted) {
        this.totals.shed += 1;
        this.metrics.requests.inc({
          model: request.model,
          version: 'n/a',
          outcome: admitted.reason,
        });
        span.setError(admitted.reason).setAttribute('halcyon.shed_reason', admitted.reason);
        throw new EngineError(
          admitted.reason,
          `Request rejected: ${admitted.reason}`,
          admitted.retryAfterMs,
        );
      }

      let released = false;
      const release = (ok: boolean) => {
        if (released) return;
        released = true;
        this.admission.release(Date.now() - startedAt, ok);
      };

      try {
        // 2. Version resolution. Sticky on `sessionKey` so a user does not cross versions
        // mid-conversation while a canary ramps.
        const version = this.resolveVersion(request.model, request.sessionKey ?? requestId);
        span.setAttribute('halcyon.version', version);

        const response = await this.enqueue(request, tenantId, requestId, version, span);
        release(true);

        const totalMs = Date.now() - startedAt;
        this.globalLatency.record(totalMs);
        this.recordWindow(request.model, version, totalMs, false);
        this.metrics.requests.inc({ model: request.model, version, outcome: 'ok' });
        this.metrics.latency.observe(totalMs, { model: request.model, version });
        span.setOk();
        return response;
      } catch (error) {
        release(false);
        throw error;
      }
    } catch (error) {
      if (!(error instanceof EngineError)) {
        this.totals.errors += 1;
        span.setError(error instanceof Error ? error.message : 'unknown error');
        this.logger.error('inference failed', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new EngineError('upstream_failure', 'Inference failed');
      }
      if (error.code === 'upstream_failure') this.totals.errors += 1;
      throw error;
    } finally {
      span.end();
      this.publishGauges();
    }
  }

  private resolveVersion(modelId: string, stickyKey: string): string {
    const splitter = this.splitters.get(modelId);
    if (!splitter) {
      throw new EngineError('model_not_found', `No versions registered for model '${modelId}'`);
    }
    return splitter.select(stickyKey);
  }

  private enqueue(
    request: InferenceRequest,
    tenantId: string,
    requestId: string,
    version: string,
    parentSpan: Span,
  ): Promise<InferenceResponse> {
    const batcher = this.ensureBatcher(request.model, version);
    const queueSpan = parentSpan.child('halcyon.queue');

    return new Promise<InferenceResponse>((resolve, reject) => {
      const now = Date.now();
      const result = batcher.enqueue({
        id: requestId,
        payload: {
          requestId,
          tenantId,
          input: request.input,
          maxOutputTokens: request.maxOutputTokens,
          enqueuedAt: now,
          span: queueSpan,
          resolve,
          reject,
        },
        // Work units are estimated from the output budget: for autoregressive models the
        // decode phase dominates, and it scales with tokens generated, not tokens supplied.
        tokens: request.maxOutputTokens,
        lane: request.lane === 'bulk' ? Lane.Bulk : Lane.Interactive,
        deadlineAt: now + request.deadlineMs,
        enqueuedAt: now,
      });

      if (!result.accepted) {
        queueSpan.setError(result.reason).end();
        this.totals.shed += 1;
        this.metrics.requests.inc({ model: request.model, version, outcome: result.reason });
        reject(
          new EngineError(
            result.reason,
            result.reason === 'deadline_unreachable'
              ? `Deadline of ${request.deadlineMs}ms cannot be met at current load`
              : 'Scheduler queue is full',
          ),
        );
      }
    });
  }

  private ensureBatcher(modelId: string, version: string): ContinuousBatcher<PendingRequest> {
    const key = modelKey(modelId, version);
    const existing = this.batchers.get(key);
    if (existing) return existing;

    const batcher = new ContinuousBatcher<PendingRequest>({
      maxBatchSize: this.config.maxBatchSize,
      maxBatchTokens: this.config.maxBatchTokens,
      maxQueueDepth: this.config.maxQueueDepth,
      lingerMs: this.config.lingerMs,
      safetyMarginMs: this.config.safetyMarginMs,
      starvationGuardMs: this.config.starvationGuardMs,
      clock: this.clock,
      // Do not dispatch more concurrent batches than the fleet can absorb. Without this the
      // scheduler would happily push work into a queue it cannot see, and its own latency
      // predictions — which assume the batch starts executing on dispatch — become fiction.
      canFlush: () => this.hasDispatchCapacity(key, modelId, version),
      pendingWorkMs: () => this.pendingWorkMs(key),
      onFlush: (batch) => {
        void this.dispatch(modelId, version, batch);
      },
      // A request whose deadline elapsed while queued is failed explicitly. This is the path
      // taken when downstream capacity never returns — every replica draining, or a fleet
      // outage — and it is what stops a caller's connection being held open indefinitely.
      onExpire: (item) => {
        this.totals.shed += 1;
        this.metrics.requests.inc({ model: modelId, version, outcome: 'deadline_expired' });
        item.payload.span.setError('deadline_expired').end();
        item.payload.reject(
          new EngineError('deadline_unreachable', 'Deadline elapsed while queued for capacity'),
        );
      },
    });
    this.batchers.set(key, batcher);
    return batcher;
  }

  private hasDispatchCapacity(key: string, modelId: string, version: string): boolean {
    const replicaCount = this.router
      .snapshot()
      .filter((r) => r.modelId === modelId && r.version === version && !r.draining).length;
    if (replicaCount === 0) return false;
    const inFlight = this.inFlightBatches.get(key)?.count ?? 0;
    return inFlight < replicaCount * this.config.maxInFlightBatchesPerReplica;
  }

  /** Remaining time on batches already dispatched, spread across the fleet. */
  private pendingWorkMs(key: string): number {
    const entry = this.inFlightBatches.get(key);
    if (!entry || entry.estimatedEndAt.length === 0) return 0;
    const now = Date.now();
    const remaining = entry.estimatedEndAt
      .map((endAt) => Math.max(0, endAt - now))
      .sort((a, b) => a - b);
    // The next free slot is the soonest-finishing batch, so that is the wait a newly
    // dispatched batch actually faces — not the sum of everything outstanding.
    return remaining[0] ?? 0;
  }

  // -------------------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------------------

  private async dispatch(
    modelId: string,
    version: string,
    batch: BatchFlush<PendingRequest>,
  ): Promise<void> {
    const key = modelKey(modelId, version);
    const batchId = randomUUID();
    const batcher = this.batchers.get(key);
    const predictedMs = batcher?.model.predict(batch.totalTokens) ?? 100;

    this.trackBatchStart(key, predictedMs);
    this.metrics.batchSize.observe(batch.items.length, { model: modelId, version });

    const dispatchedAt = Date.now();
    for (const item of batch.items) {
      item.payload.span.setAttributes({
        'halcyon.batch_id': batchId,
        'halcyon.batch_size': batch.items.length,
        'halcyon.flush_reason': batch.reason,
      });
      item.payload.span.end();
      this.metrics.queueWait.observe(dispatchedAt - item.payload.enqueuedAt, {
        model: modelId,
        version,
      });
    }

    try {
      const { response, replicaId, hedged } = await this.executeWithHedge(
        modelId,
        version,
        batchId,
        batch,
      );
      const executionMs = Date.now() - dispatchedAt;
      batcher?.recordExecution(batch.totalTokens, executionMs);
      this.metrics.execution.observe(executionMs, { model: modelId, version });

      const byRequest = new Map(response.results.map((r) => [r.requestId, r]));
      for (const item of batch.items) {
        const result = byRequest.get(item.payload.requestId);
        if (!result) {
          // The replica returned a batch missing this request. Failing the individual
          // request is right; failing the whole batch would punish requests that succeeded.
          item.payload.reject(new EngineError('upstream_failure', 'Replica omitted this request'));
          continue;
        }
        const totalMs = Date.now() - item.payload.enqueuedAt;
        this.chargeUsage(
          item.payload.tenantId,
          modelId,
          result.promptTokens,
          result.completionTokens,
        );
        item.payload.resolve({
          requestId: item.payload.requestId,
          model: modelId,
          version,
          output: result.output,
          replicaId,
          hedged,
          usage: {
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
          },
          timings: {
            queuedMs: Math.max(0, dispatchedAt - item.payload.enqueuedAt),
            executionMs,
            totalMs,
          },
          batch: { size: batch.items.length, reason: batch.reason },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordWindow(modelId, version, 0, true);
      this.metrics.requests.inc({ model: modelId, version, outcome: 'upstream_error' });
      this.logger.warn('batch dispatch failed', {
        batchId,
        model: modelId,
        version,
        error: message,
      });
      for (const item of batch.items) {
        item.payload.reject(new EngineError('upstream_failure', message));
      }
    } finally {
      this.trackBatchEnd(key);
      // A slot just freed up — let the scheduler dispatch immediately instead of waiting
      // for its next polling tick.
      batcher?.signalCapacity();
    }
  }

  /**
   * Executes a batch, optionally racing a second replica.
   *
   * Hedging is fired at the fleet's p95, so by construction it costs about 5% extra load
   * while targeting exactly the requests that are already behaving abnormally. The loser of
   * the race is aborted rather than left running, because an orphaned batch still occupies
   * an accelerator and would distort the very latency estimates that triggered the hedge.
   */
  private async executeWithHedge(
    modelId: string,
    version: string,
    batchId: string,
    batch: BatchFlush<PendingRequest>,
  ): Promise<{ response: BatchExecutionResponse; replicaId: string; hedged: boolean }> {
    const primary = this.router.pick(modelId, version);
    if (!primary.ok) {
      throw new EngineError('no_capacity', `No available replica for ${modelId}@${version}`);
    }

    const payload = {
      batchId,
      items: batch.items.map((item) => ({
        requestId: item.payload.requestId,
        input: item.payload.input,
        maxOutputTokens: item.payload.maxOutputTokens,
      })),
    };

    const hedgeDelay = this.config.hedgingEnabled
      ? this.router.hedgeDelayMs(modelId, version, this.config.hedgeMinimumSamples)
      : null;

    type Attempt = { response: BatchExecutionResponse; replicaId: string; hedged: boolean };

    const primaryAbort = new AbortController();
    const hedgeAbort = new AbortController();
    let hedgeTimer: NodeJS.Timeout | null = null;

    const attempts: Promise<Attempt>[] = [
      this.callReplica(primary.replica, payload, primaryAbort.signal).then((response) => ({
        response,
        replicaId: primary.replica.id,
        hedged: false,
      })),
    ];

    if (hedgeDelay !== null) {
      attempts.push(
        new Promise<Attempt>((resolve, reject) => {
          hedgeTimer = setTimeout(() => {
            const backup = this.router.pick(modelId, version, primary.replica.id);
            if (!backup.ok) {
              // Nowhere to hedge to. This attempt must still *settle*, or `Promise.any`
              // would wait on it forever should the primary also fail.
              reject(new Error('no hedge target available'));
              return;
            }
            this.totals.hedged += 1;
            this.metrics.hedges.inc({ model: modelId, version });
            this.callReplica(backup.replica, payload, hedgeAbort.signal)
              .then((response) => {
                this.metrics.hedgeWins.inc({ model: modelId, version });
                resolve({ response, replicaId: backup.replica.id, hedged: true });
              })
              .catch(reject);
          }, hedgeDelay);
          hedgeTimer.unref();
        }),
      );
    }

    try {
      // `Promise.any`, not `Promise.race`. Race settles on the first promise to settle —
      // including one that *rejects* — so a hedge that fails fast (a busy replica answering
      // in 2ms) would kill a batch whose primary is running perfectly well. That is the
      // precise failure mode hedging exists to prevent, so the semantics must be "succeed
      // if any attempt succeeds; fail only if all of them fail".
      const winner = await Promise.any(attempts);
      // Stand down the loser so it stops occupying an accelerator.
      if (winner.hedged) primaryAbort.abort();
      else hedgeAbort.abort();
      return winner;
    } catch (error) {
      primaryAbort.abort();
      hedgeAbort.abort();
      if (error instanceof AggregateError) {
        const first = error.errors.find((e): e is Error => e instanceof Error);
        throw new EngineError('upstream_failure', first?.message ?? 'All replicas failed');
      }
      throw error;
    } finally {
      if (hedgeTimer) clearTimeout(hedgeTimer);
    }
  }

  private async callReplica(
    replica: ReplicaSpec,
    payload: { batchId: string; items: unknown[] },
    signal: AbortSignal,
  ): Promise<BatchExecutionResponse> {
    const startedAt = Date.now();
    this.router.dispatchStarted(replica.id);
    try {
      const response = await fetch(`${replica.address}/v1/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.upstreamTimeoutMs)]),
      });
      if (!response.ok) {
        throw new Error(`Replica ${replica.id} returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as BatchExecutionResponse;
      this.router.dispatchCompleted(replica.id, Date.now() - startedAt, true);
      return body;
    } catch (error) {
      // An abort is a deliberate cancellation of a hedge loser, not evidence that the
      // replica is unhealthy — scoring it as a failure would trip the breaker on a replica
      // that did nothing wrong.
      const aborted = error instanceof Error && error.name === 'AbortError';
      this.router.dispatchCompleted(replica.id, Date.now() - startedAt, aborted);
      throw error;
    }
  }

  private trackBatchStart(key: string, predictedMs: number): void {
    const entry = this.inFlightBatches.get(key) ?? { count: 0, estimatedEndAt: [] };
    entry.count += 1;
    entry.estimatedEndAt.push(Date.now() + predictedMs);
    this.inFlightBatches.set(key, entry);
  }

  private trackBatchEnd(key: string): void {
    const entry = this.inFlightBatches.get(key);
    if (!entry) return;
    entry.count = Math.max(0, entry.count - 1);
    entry.estimatedEndAt.shift();
  }

  private chargeUsage(
    tenantId: string,
    modelId: string,
    promptTokens: number,
    completionTokens: number,
  ): void {
    const total = promptTokens + completionTokens;
    this.metrics.tokens.inc({ model: modelId, kind: 'prompt' }, promptTokens);
    this.metrics.tokens.inc({ model: modelId, kind: 'completion' }, completionTokens);
    const micros = Math.round((total / 1_000) * this.config.costMicrosInrPerKiloToken);
    this.metrics.costInr.inc({ tenant: tenantId, model: modelId }, micros);
  }

  // -------------------------------------------------------------------------------------
  // Progressive rollout
  // -------------------------------------------------------------------------------------

  startRollout(
    modelId: string,
    baselineVersion: string,
    canaryVersion: string,
    policy: Record<string, unknown> = {},
  ): void {
    const versions = this.modelVersions.get(modelId);
    if (!versions?.has(baselineVersion) || !versions.has(canaryVersion)) {
      throw new EngineError(
        'model_not_found',
        `Both versions must have registered replicas before a rollout can start`,
      );
    }
    const controller = new CanaryController(baselineVersion, canaryVersion, this.clock, policy);
    controller.start();
    this.rollouts.set(modelId, controller);
    this.applySplit(modelId, controller);
    this.ensureBatcher(modelId, canaryVersion);
    this.logger.info('rollout started', { modelId, baselineVersion, canaryVersion });
  }

  abortRollout(modelId: string): void {
    const controller = this.rollouts.get(modelId);
    if (!controller) throw new EngineError('model_not_found', `No active rollout for '${modelId}'`);
    controller.abort();
    this.applySplit(modelId, controller);
    this.logger.warn('rollout aborted by operator', { modelId });
  }

  promoteRollout(modelId: string): void {
    const controller = this.rollouts.get(modelId);
    if (!controller) throw new EngineError('model_not_found', `No active rollout for '${modelId}'`);
    controller.forcePromote();
    this.applySplit(modelId, controller);
    this.logger.info('rollout force-promoted by operator', { modelId });
  }

  /** The control loop. Analyses every active rollout on a fixed cadence. */
  startControlLoop(): void {
    if (this.analysisTimer) return;
    this.analysisTimer = setInterval(() => {
      for (const [modelId, controller] of this.rollouts) {
        const state = controller.snapshot();
        if (state.phase === 'promoted' || state.phase === 'rolled_back') continue;

        const baseline = this.takeWindow(modelId, state.baselineVersion);
        const canary = this.takeWindow(modelId, state.canaryVersion);
        const verdict = controller.analyse(baseline, canary);
        this.metrics.rolloutEvents.inc({ model: modelId, verdict: verdict.decision });

        if (verdict.decision !== 'hold') {
          this.logger.info('rollout verdict', {
            modelId,
            decision: verdict.decision,
            reason: 'reason' in verdict ? verdict.reason : undefined,
            canaryPercent: controller.snapshot().canaryPercent,
            baseline,
            canary,
          });
          this.applySplit(modelId, controller);
        }
      }
      this.router.reapStale();
      this.publishGauges();
    }, this.config.canaryAnalysisIntervalMs);
    this.analysisTimer.unref();
  }

  private applySplit(modelId: string, controller: CanaryController): void {
    const split = controller.split;
    const splitter = this.splitters.get(modelId);
    if (splitter) splitter.update(split);
    else this.splitters.set(modelId, new TrafficSplitter(split, modelId));
    const canary = split.find((v) => v.version === controller.snapshot().canaryVersion);
    this.metrics.canaryPercent.set(canary?.weight ?? 0, { model: modelId });
  }

  private recordWindow(
    modelId: string,
    version: string,
    latencyMs: number,
    isError: boolean,
  ): void {
    const key = modelKey(modelId, version);
    let window = this.windows.get(key);
    if (!window) {
      window = { requests: 0, errors: 0, latency: new LatencyHistogram(8, 600_000) };
      this.windows.set(key, window);
    }
    window.requests += 1;
    if (isError) window.errors += 1;
    else window.latency.record(latencyMs);
  }

  /** Reads and resets a version's window — canary analysis compares *intervals*, not totals. */
  private takeWindow(modelId: string, version: string): VariantMetrics {
    const key = modelKey(modelId, version);
    const window = this.windows.get(key);
    if (!window) return { requests: 0, errors: 0, p95LatencyMs: 0 };
    const snapshot: VariantMetrics = {
      requests: window.requests,
      errors: window.errors,
      p95LatencyMs: window.latency.p95,
    };
    this.windows.set(key, { requests: 0, errors: 0, latency: new LatencyHistogram(8, 600_000) });
    return snapshot;
  }

  private publishGauges(): void {
    let depth = 0;
    for (const batcher of this.batchers.values()) depth += batcher.depth;
    this.metrics.queueDepth.set(depth);
    this.metrics.concurrencyLimit.set(this.admission.concurrencyLimit);
    this.metrics.inflight.set(this.admission.inflight);
    const replicas = this.router.snapshot();
    this.metrics.replicas.set(replicas.filter((r) => !r.draining).length, { state: 'active' });
    this.metrics.replicas.set(replicas.filter((r) => r.draining).length, { state: 'draining' });
    this.metrics.replicas.set(replicas.filter((r) => r.breaker.state !== 'closed').length, {
      state: 'unhealthy',
    });
  }

  // -------------------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------------------

  snapshot() {
    const batching: Record<string, unknown> = {};
    for (const [key, batcher] of this.batchers) batching[key] = batcher.snapshot();

    return {
      generatedAt: Date.now(),
      uptimeMs: Date.now() - this.startedAt,
      models: [...this.modelVersions.entries()].map(([modelId, versions]) => {
        const controller = this.rollouts.get(modelId);
        const state = controller?.snapshot();
        return {
          modelId,
          versions: [...versions],
          split: [...(this.splitters.get(modelId)?.current ?? [])],
          rollout: state
            ? {
                phase: state.phase,
                baselineVersion: state.baselineVersion,
                canaryVersion: state.canaryVersion,
                canaryPercent: state.canaryPercent,
                healthyStreak: state.healthyStreak,
                unhealthyStreak: state.unhealthyStreak,
                startedAt: state.startedAt,
              }
            : null,
        };
      }),
      replicas: this.router.snapshot(),
      batching,
      admission: this.admission.snapshot(),
      traffic: {
        requests: this.totals.requests,
        errors: this.totals.errors,
        shed: this.totals.shed,
        hedged: this.totals.hedged,
        latency: this.globalLatency.snapshot(),
      },
    };
  }

  rolloutHistory(modelId: string) {
    return this.rollouts.get(modelId)?.snapshot().history ?? [];
  }

  async shutdown(): Promise<void> {
    if (this.analysisTimer) clearInterval(this.analysisTimer);
    this.analysisTimer = null;
    // Drain rather than drop: requests already accepted have an SLO we promised to honour.
    for (const batcher of this.batchers.values()) batcher.close();
    await this.tracer.shutdown();
  }
}
