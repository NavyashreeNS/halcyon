# ADR 0005 — In-memory scheduling state, Postgres for configuration and history

**Status:** Accepted · **Date:** 2026-01-18

## Context

The control plane holds two kinds of state, and they have almost nothing in common.

**Scheduling state** — queue contents, per-replica EWMA latencies, circuit-breaker windows,
the fitted cost model, the adaptive concurrency limit. It changes thousands of times per
second and is worthless a second later.

**Configuration and history** — tenants and quotas, model versions, rollout definitions, the
audit trail of canary decisions, per-request billing records. It changes rarely and must
survive a restart.

The tempting move is to put both in one durable store, so that any instance can serve any
request identically. That instinct is right for configuration and catastrophic for scheduling:
it adds a database round trip to the request path in exchange for durability of data whose
useful lifetime is shorter than the round trip.

## Decision

Scheduling state lives in process memory. Configuration and history live in Postgres.

The consequence to confront head-on is that each gateway instance schedules against its own
view. Halcyon accepts this deliberately, because the algorithms are chosen to be correct under
partial information:

- **Power-of-two-choices routing** is not merely tolerant of independent instances — it
  _requires_ them. Instances sharing one global load view would stampede the same replica
  together (see ADR 0002).
- **Per-instance adaptive limits** compose: each instance discovers its own share of fleet
  capacity, and the sum tracks the whole. A single shared limit would need distributed
  consensus on the hottest path in the system.
- **Hash-based canary assignment** is deterministic from the request key, so every instance
  independently computes the same version with no coordination at all (see ADR 0004).

The genuine cost is per-tenant rate limiting. With _n_ gateways, a tenant can burst up to _n_
times its configured rate before any single instance notices. This is accepted: quotas are a
fairness mechanism, not a security boundary, and the fleet-wide adaptive limiter is the actual
protection against overload. Should exact global quotas ever be required, the right shape is a
Redis token bucket on that check alone — not a redesign of scheduling.

Restarts lose queued requests, which is why the batcher drains on `SIGTERM` and Kubernetes
`preStop` hooks pause long enough for endpoint removal to propagate before the listener closes.

In Postgres, money is stored as **integer micro-rupees**. Floating-point currency accumulates
rounding error that surfaces as invoices which do not reconcile; the fix is always an integer
minor unit, divided exactly once at the presentation layer.

## Consequences

- The request path makes zero database calls. A total Postgres outage degrades the control
  plane to read-only — no new rollouts, no quota changes — while inference continues serving.
- Metrics are per-instance and aggregated at scrape time. This is why the gateway exports
  histogram _buckets_ rather than pre-computed quantiles: buckets aggregate across instances
  correctly, and quantiles do not. Averaging p99s is meaningless.
- Testing is dramatically simpler. Every algorithm takes an injectable `Clock`, so the entire
  scheduling and rollout surface is exercised deterministically with no I/O and no sleeps — 100
  tests in under three seconds.

## Alternatives considered

- **Redis for shared scheduling state** — a network hop on the hot path, a new failure domain,
  and it would break P2C's core property.
- **Raft/etcd consensus** — correct, and wildly disproportionate. Consensus is for state where
  disagreement is unacceptable; here, disagreement is the design.
- **Everything in memory including configuration** — loses the audit trail, which is precisely
  what answers "why did the rollout stop at 3am".
