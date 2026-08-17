# ADR 0002 — Peak-EWMA scoring under power-of-two-choices

**Status:** Accepted · **Date:** 2026-01-15

## Context

An inference fleet is heterogeneous in ways a web fleet is not. Replicas differ by hardware
generation, by what is resident in their KV cache, and by co-tenancy on the same physical
device. Request cost varies by an order of magnitude within one model. Consequently:

- **Round-robin** assumes replicas and requests are interchangeable. Neither holds.
- **Least-connections** counts requests without weighing them, so a replica holding three cheap
  requests looks busier than one holding a single enormous batch.
- **Global least-loaded** is the obvious fix and fails in a subtle way: every gateway instance
  independently computes the same "best" replica and they all stampede it, then all stampede
  the next one. The fleet oscillates, and the oscillation gets worse as you add gateways.

There is also a failure mode specific to latency-based balancing. A replica that has begun
OOM-ing or thermal-throttling fails requests in milliseconds. Because it fails _fast_, a
latency-aware balancer routes it more traffic — the classic black-hole.

## Decision

Score each replica by its estimated queueing delay for a new request:

```
score = (inflight + 1) × ewmaLatency / weight
```

and select by sampling **two candidates at random** and taking the better one.

Each term earns its place:

- `inflight + 1` is Little's Law per replica. The `+1` keeps an idle replica attractive without
  being infinitely attractive, so new replicas warm up rather than being flooded.
- `ewmaLatency` decays by _elapsed time_, not sample count. A plain EWMA freezes at its last
  observation when a replica stops receiving traffic, making a shunned replica look permanently
  excellent.
- `weight` normalises capacity, so an H100 absorbs proportionally more than an A10G.
- **Two choices, not the global minimum.** This provably reduces maximum load from
  Θ(log n / log log n) to Θ(log log n) while being immune to the herd resonance above, because
  independent gateways sample independently.

Health is handled separately, on _outcomes_ rather than timing: a per-replica circuit breaker
with a sliding outcome window, exponential re-open backoff, and limited half-open probes. This
is what closes the black-hole hole — a fast-failing replica is removed regardless of how
attractive its latency looks.

## Consequences

Two bugs found while integrating this are worth recording, because both are easy to write and
hard to see.

**Probe-slot leakage.** The first implementation used the breaker's `tryAcquire` to filter
eligible replicas. `tryAcquire` has side effects — it reserves a half-open probe slot — so
every replica _considered_ consumed budget, and only the one _chosen_ ever released it. After a
few picks, recovering replicas were permanently unprobeable. Eligibility now uses a
non-mutating `peek`, and only the winner acquires.

**Scoring is not exclusion.** Peak-EWMA makes a busy replica less attractive, but a worker that
physically accepts one batch at a time needs it to be _ineligible_. A sufficiently slow replica
could still win a comparison while already occupied, and the dispatch was rejected on arrival
— 2.7% of requests in a live load test. The router now takes an optional hard concurrency
ceiling per replica.

The remaining cost is that P2C is not optimal, only near-optimal, and deliberately so. On a
fleet of two it degenerates to comparing both, which is fine.

## Alternatives considered

- **Consistent hashing** — excellent for cache affinity, and it was tempting given KV-cache
  locality. Rejected because it cannot respond to load at all: a hot key pins its replica.
- **Client-side load reporting** — more accurate, at the cost of a control channel and a
  staleness window during exactly the failures it needs to catch.
