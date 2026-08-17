# ADR 0001 — Deadline-aware batching over fixed-size or fixed-timeout batching

**Status:** Accepted · **Date:** 2026-01-14

## Context

Executing one inference request per accelerator invocation wastes most of the device. Service
time is affine in batch size — a fixed kernel-launch and weight-paging cost plus a marginal
per-token cost — so with an 18ms fixed cost and 0.022ms/token, a single 200-token request
spends 80% of its GPU time on overhead. Batching amortises that fixed cost.

The cost of batching is latency: to build a batch you must wait for requests to arrive. The
two conventional strategies each pick one horn of the dilemma.

- **Fixed size.** Wait for N requests. Under light traffic the Nth request may never come, and
  the first request in the batch waits indefinitely.
- **Fixed timeout.** Flush every T milliseconds. T is a guess, correct at exactly one arrival
  rate. Too large and light traffic pays T of pure latency; too small and heavy traffic never
  builds a batch worth having.

Both are blind to the only thing that actually matters: whether the requests in hand will still
be useful when they finish.

## Decision

Batching is treated as a scheduling problem with an explicit feasibility test. Requests carry
an absolute deadline. The scheduler orders them earliest-deadline-first and, on every arrival
and timer expiry, asks whether there is slack remaining before the tightest deadline in the
queue, given a cost model fitted online from observed executions:

```
slack = earliestDeadline − now − predictedCost(queuedTokens) − safetyMargin − inFlightWork
```

Positive slack means the batch may keep growing. Non-positive slack means flush immediately,
however small the batch. A `lingerMs` ceiling bounds waiting when every deadline is generous.

Two consequences follow that the conventional strategies cannot provide:

1. **Batch size becomes emergent rather than configured.** It is large when traffic is heavy
   and deadlines are loose, and size-of-one when a lone urgent request hits an idle system.
2. **The system can shed.** If a request's deadline is unreachable even in the best case, it
   is rejected in microseconds instead of consuming a GPU slot and returning a response nobody
   is waiting for.

## Consequences

Measured on a seeded simulation with mixed SLOs (`npm run bench`), against fixed batching:

| load               | fixed batching                     | Halcyon                        |
| ------------------ | ---------------------------------- | ------------------------------ |
| saturated, 200 rps | 155.7 goodput/s · 27.9% urgent SLO | **163.6** · **41.0%**          |
| overload, 260 rps  | 5.2 goodput/s · p50 2398ms         | **83.1** (16×) · p50 **885ms** |

Below saturation the two are indistinguishable, which is the honest result: deadline-awareness
earns nothing when there is slack for everyone. It earns everything at the edge.

The costs are real. The scheduler needs an accurate cost model, and a wrong one is actively
harmful — an over-estimating model sheds traffic it could have served. This bit us during
development: independently clamping the fitted slope and intercept to be non-negative produced
an inflated intercept of 6.9 seconds, and the scheduler correctly concluded that every 2-second
deadline was unreachable, rejecting 4,889 servable requests. The fix was constrained least
squares (re-solving with the violated constraint held active) plus a conditioning guard that
keeps the estimator on its prior until it has observed a genuine spread of batch shapes.

Clients must also supply meaningful deadlines. A caller that sends `deadlineMs: 600000` opts
out of every protection described here.

## Alternatives considered

- **Fixed-size batching with a timeout fallback** — the industry default. Simpler, and strictly
  worse at the edges, where behaviour matters most.
- **Priority queues without deadlines** — answers "who goes first" but never "can this still be
  served", so it cannot shed and collapses identically under overload.
