'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BatcherView, ControlPlaneState, ModelView, ReplicaView } from '@/lib/types';
import {
  compactNumber,
  duration,
  gatewayUrl,
  latencyTone,
  ms,
  percent,
  versionColour,
} from '@/lib/format';
import { Badge, Bar, Distribution, Empty, Panel, Row, Tile, type Tone } from './primitives';

const POLL_INTERVAL_MS = 2_000;

export function Dashboard() {
  const [state, setState] = useState<ControlPlaneState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Throughput is derived by differencing successive request counters rather than read from
   * the gateway. The gateway only exposes cumulative totals — dividing those by uptime would
   * report a lifetime average that barely moves, which is useless for watching a live system
   * respond to load.
   */
  const previous = useRef<{ requests: number; at: number } | null>(null);
  const [throughput, setThroughput] = useState(0);

  const poll = useCallback(async () => {
    try {
      const response = await fetch(`${gatewayUrl()}/v1/control/state`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`gateway returned HTTP ${response.status}`);
      const next = (await response.json()) as ControlPlaneState;

      const now = Date.now();
      const prior = previous.current;
      if (prior && now > prior.at) {
        const delta = next.traffic.requests - prior.requests;
        const seconds = (now - prior.at) / 1_000;
        if (delta >= 0) setThroughput(delta / seconds);
      }
      previous.current = { requests: next.traffic.requests, at: now };

      setState(next);
      setLastUpdate(now);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  const act = useCallback(
    async (path: string, method = 'POST') => {
      setBusy(true);
      try {
        const response = await fetch(`${gatewayUrl()}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
        }
        await poll();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [poll],
  );

  const staleness = lastUpdate ? Date.now() - lastUpdate : Infinity;
  const connection: 'live' | 'stale' | 'down' =
    error && !state ? 'down' : staleness > POLL_INTERVAL_MS * 3 ? 'stale' : 'live';

  return (
    <div className="shell">
      <Masthead connection={connection} state={state} throughput={throughput} />

      {error ? <div className="error-banner">Control plane unreachable — {error}</div> : null}

      {!state ? (
        <Panel title="Connecting">
          <Empty>
            Waiting for the gateway at <code>{gatewayUrl()}</code>. Start the stack with{' '}
            <code>npm run stack:up</code> or <code>node scripts/dev-stack.mjs</code>.
          </Empty>
        </Panel>
      ) : (
        <>
          <Tiles state={state} throughput={throughput} />
          {state.models.map((model) => (
            <RolloutPanel key={model.modelId} model={model} busy={busy} act={act} />
          ))}
          <ReplicaPanel replicas={state.replicas} />
          <div className="grid grid-2">
            <SchedulerPanel batching={state.batching} />
            <AdmissionPanel state={state} />
          </div>
        </>
      )}

      <footer className="footnote">
        <span>
          Halcyon control plane · polling {gatewayUrl()} every {POLL_INTERVAL_MS / 1_000}s
        </span>
        <span>{state ? `uptime ${duration(state.uptimeMs)}` : 'disconnected'}</span>
      </footer>
    </div>
  );
}

function Masthead({
  connection,
  state,
  throughput,
}: {
  connection: 'live' | 'stale' | 'down';
  state: ControlPlaneState | null;
  throughput: number;
}) {
  const label =
    connection === 'live'
      ? `live · ${throughput.toFixed(0)} req/s`
      : connection === 'stale'
        ? 'stale'
        : 'disconnected';
  return (
    <header className="masthead">
      <div className="brand">
        <Mark />
        <div>
          <h1>Halcyon</h1>
          <p>Real-time inference control plane</p>
        </div>
      </div>
      <div className="masthead-meta">
        <span className="pulse">
          <span className="pulse-dot" data-state={connection === 'live' ? undefined : connection} />
          {label}
        </span>
        {state ? (
          <span className="pulse">{state.replicas.filter((r) => !r.draining).length} replicas</span>
        ) : null}
      </div>
    </header>
  );
}

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#0d1117" stroke="#2a3644" />
      {/* Three queued requests coalescing into one batch — the system's core idea, drawn. */}
      <circle cx="10" cy="12" r="2.6" fill="#4c9aff" />
      <circle cx="10" cy="20" r="2.6" fill="#4c9aff" opacity="0.75" />
      <circle cx="10" cy="28" r="2.6" fill="#4c9aff" opacity="0.5" />
      <path
        d="M14 12 Q22 12 24 20 Q22 28 14 28 M14 20 H24"
        stroke="#bc8cff"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      <rect x="26" y="15" width="8" height="10" rx="2.5" fill="#3fb950" />
    </svg>
  );
}

function Tiles({ state, throughput }: { state: ControlPlaneState; throughput: number }) {
  const { traffic, admission } = state;
  const totalQueue = Object.values(state.batching).reduce((sum, b) => sum + b.queueDepth, 0);
  const totalBatches = Object.values(state.batching).reduce((sum, b) => sum + b.batchesFlushed, 0);
  const totalItems = Object.values(state.batching).reduce((sum, b) => sum + b.itemsFlushed, 0);
  const meanBatch = totalBatches === 0 ? 0 : totalItems / totalBatches;
  const shedRate = traffic.requests === 0 ? 0 : traffic.shed / traffic.requests;

  return (
    <div className="tiles">
      <Tile
        label="Throughput"
        value={throughput.toFixed(0)}
        unit="req/s"
        sub={`${compactNumber(traffic.requests)} total`}
      />
      <Tile
        label="Latency p95"
        value={ms(traffic.latency.p95)}
        unit="ms"
        sub={`p50 ${ms(traffic.latency.p50)} · p99 ${ms(traffic.latency.p99)}`}
      />
      <Tile
        label="Mean batch size"
        value={meanBatch.toFixed(1)}
        sub={`${compactNumber(totalBatches)} batches dispatched`}
      />
      <Tile
        label="Queue depth"
        value={String(totalQueue)}
        sub={`concurrency limit ${admission.limiter.limit}`}
      />
      <Tile
        label="Shed"
        value={percent(shedRate, 2)}
        sub={`${compactNumber(traffic.shed)} rejected upfront`}
      />
      <Tile
        label="Hedged"
        value={compactNumber(traffic.hedged)}
        sub={`${compactNumber(traffic.errors)} errors`}
      />
    </div>
  );
}

function RolloutPanel({
  model,
  busy,
  act,
}: {
  model: ModelView;
  busy: boolean;
  act: (path: string, method?: string) => Promise<void>;
}) {
  const { rollout } = model;
  const phaseTone: Record<string, Tone> = {
    idle: 'neutral',
    progressing: 'info',
    paused: 'warn',
    promoted: 'ok',
    rolled_back: 'danger',
  };
  const active = rollout && rollout.phase !== 'promoted' && rollout.phase !== 'rolled_back';

  return (
    <Panel
      title={model.modelId}
      note={
        rollout
          ? `${rollout.baselineVersion} → ${rollout.canaryVersion} · started ${duration(
              Date.now() - rollout.startedAt,
            )} ago`
          : `${model.versions.length} version${model.versions.length === 1 ? '' : 's'} registered · no active rollout`
      }
      action={
        rollout ? (
          <div className="btn-row">
            <Badge tone={phaseTone[rollout.phase] ?? 'neutral'}>
              {rollout.phase.replace('_', ' ')}
            </Badge>
            {active ? (
              <>
                <button
                  className="btn"
                  data-variant="primary"
                  disabled={busy}
                  onClick={() => void act(`/v1/control/rollouts/${model.modelId}/promote`)}
                >
                  Promote
                </button>
                <button
                  className="btn"
                  data-variant="danger"
                  disabled={busy}
                  onClick={() => void act(`/v1/control/rollouts/${model.modelId}/abort`)}
                >
                  Roll back
                </button>
              </>
            ) : null}
          </div>
        ) : null
      }
    >
      <div className="split-bar" role="img" aria-label="traffic split by model version">
        {model.split.map((variant) => (
          <div
            key={variant.version}
            className="split-seg"
            style={{
              width: `${variant.weight}%`,
              background: versionColour(variant.version, model.versions),
            }}
            title={`${variant.version}: ${variant.weight.toFixed(1)}%`}
          >
            {variant.weight >= 12 ? `${variant.version} ${variant.weight.toFixed(0)}%` : null}
          </div>
        ))}
      </div>

      {rollout ? (
        <div className="rows" style={{ marginTop: 15 }}>
          <Row label="Canary traffic" value={`${rollout.canaryPercent.toFixed(0)}%`} />
          <Row
            label="Consecutive healthy analyses"
            value={
              <>
                {rollout.healthyStreak}
                {rollout.unhealthyStreak > 0 ? (
                  <span style={{ color: 'var(--danger)' }}>
                    {' '}
                    · {rollout.unhealthyStreak} unhealthy
                  </span>
                ) : null}
              </>
            }
          />
        </div>
      ) : null}
    </Panel>
  );
}

function ReplicaPanel({ replicas }: { replicas: ReplicaView[] }) {
  const maxScore = Math.max(1, ...replicas.map((r) => r.score));
  const breakerTone: Record<string, Tone> = {
    closed: 'ok',
    half_open: 'warn',
    open: 'danger',
  };

  return (
    <Panel
      title="Replica fleet"
      note="Score is the router's estimate of queueing delay for a new request — lower wins."
      flush
    >
      {replicas.length === 0 ? (
        <Empty>No replicas registered. Start a worker to populate the fleet.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Replica</th>
                <th>Version</th>
                <th className="num">Weight</th>
                <th className="num">In flight</th>
                <th className="num">EWMA</th>
                <th className="num">p95</th>
                <th className="num">Dispatched</th>
                <th className="num">Failed</th>
                <th>Breaker</th>
                <th style={{ width: 120 }}>Load</th>
              </tr>
            </thead>
            <tbody>
              {replicas.map((replica) => (
                <tr key={replica.id}>
                  <td className="id">
                    {replica.id}
                    {replica.draining ? (
                      <>
                        {' '}
                        <Badge tone="warn">draining</Badge>
                      </>
                    ) : null}
                  </td>
                  <td className="id">{replica.version}</td>
                  <td className="num">{replica.weight}</td>
                  <td className="num">{replica.inflight}</td>
                  <td className="num">{ms(replica.ewmaLatencyMs)}</td>
                  <td className="num">{ms(replica.latency.p95)}</td>
                  <td className="num">{compactNumber(replica.totalDispatched)}</td>
                  <td
                    className="num"
                    style={replica.totalFailed > 0 ? { color: 'var(--danger)' } : undefined}
                  >
                    {replica.totalFailed}
                  </td>
                  <td>
                    <Badge tone={breakerTone[replica.breaker.state] ?? 'neutral'}>
                      {replica.breaker.state.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td>
                    <Bar
                      ratio={replica.score / maxScore}
                      tone={replica.breaker.state === 'closed' ? 'info' : 'danger'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function SchedulerPanel({ batching }: { batching: Record<string, BatcherView> }) {
  const entries = Object.entries(batching);
  return (
    <Panel
      title="Scheduler"
      note="Per model version: batching behaviour and the fitted cost model."
    >
      {entries.length === 0 ? (
        <Empty>No batchers active.</Empty>
      ) : (
        entries.map(([key, batcher], index) => {
          const reasons = batcher.flushReasons;
          const totalFlushes = Object.values(reasons).reduce((sum, n) => sum + n, 0) || 1;
          return (
            <div key={key} style={index > 0 ? { marginTop: 20 } : undefined}>
              <div className="id" style={{ marginBottom: 10, color: 'var(--text-muted)' }}>
                {key}
              </div>
              <div className="rows">
                <Row
                  label="Queue depth"
                  value={`${batcher.queueDepth} (${batcher.queuedTokens} tokens)`}
                />
                <Row label="Mean batch size" value={batcher.meanBatchSize.toFixed(2)} />
                <Row
                  label="Queue wait p50 / p95"
                  value={`${ms(batcher.queueWaitMs.p50)} / ${ms(batcher.queueWaitMs.p95)} ms`}
                />
                <Row
                  label="Fitted cost"
                  value={`${batcher.costModel.interceptMs.toFixed(1)}ms + ${batcher.costModel.slopeMsPerToken.toFixed(4)}/tok`}
                />
                <Row label="Shed by scheduler" value={compactNumber(batcher.itemsRejected)} />
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="panel-note" style={{ marginBottom: 6 }}>
                  Why batches were dispatched
                </div>
                <div className="btn-row">
                  {Object.entries(reasons)
                    .filter(([, count]) => count > 0)
                    .map(([reason, count]) => (
                      <Badge
                        key={reason}
                        tone={
                          reason === 'deadline' ? 'warn' : reason === 'saturated' ? 'ok' : 'neutral'
                        }
                      >
                        {reason} {percent(count / totalFlushes, 0)}
                      </Badge>
                    ))}
                </div>
              </div>
            </div>
          );
        })
      )}
    </Panel>
  );
}

function AdmissionPanel({ state }: { state: ControlPlaneState }) {
  const { limiter, rejections, admitted } = state.admission;
  const utilisation = limiter.limit === 0 ? 0 : limiter.inflight / limiter.limit;
  const { latency } = state.traffic;
  // A coarse rendering of the latency distribution from the quantiles the gateway reports.
  const shape = [latency.min, latency.p50, latency.p50, latency.p95, latency.p99, latency.max];

  return (
    <Panel
      title="Admission control"
      note="The adaptive limiter contracts when short-window latency rises above the baseline."
    >
      <div className="rows">
        <Row label="Concurrency limit" value={limiter.limit} />
        <Row label="In flight" value={`${limiter.inflight} (${percent(utilisation, 0)})`} />
        <Row
          label="Gradient"
          value={
            <span style={{ color: limiter.gradient < 0.95 ? 'var(--warn)' : 'var(--ok)' }}>
              {limiter.gradient.toFixed(3)}
            </span>
          }
        />
        <Row
          label="RTT short / long"
          value={`${ms(limiter.shortRttMs)} / ${ms(limiter.longRttMs)} ms`}
        />
        <Row label="Admitted" value={compactNumber(admitted)} />
      </div>

      <div style={{ marginTop: 14 }}>
        <Bar ratio={utilisation} tone={latencyTone(utilisation, 0.9)} />
      </div>

      {Object.keys(rejections).length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <div className="panel-note" style={{ marginBottom: 6 }}>
            Rejections by reason
          </div>
          <div className="btn-row">
            {Object.entries(rejections).map(([reason, count]) => (
              <Badge key={reason} tone="danger">
                {reason.replace('_', ' ')} {compactNumber(count)}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 18 }}>
        <div className="panel-note" style={{ marginBottom: 8 }}>
          Latency shape · min → p50 → p95 → p99 → max
        </div>
        <Distribution values={shape} />
      </div>
    </Panel>
  );
}
