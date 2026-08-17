# ADR 0003 — Adaptive concurrency limiting over static caps

**Status:** Accepted · **Date:** 2026-01-16

## Context

Every service needs a bound on concurrent work. Without one, a traffic spike converts into an
unbounded queue and every request times out — including the ones that would have succeeded had
the system simply refused some.

The usual answer is a static limit derived from a load test. It is always wrong, and it becomes
wrong in both directions:

- Set too high, queues build until the whole system is serving requests nobody is waiting for.
- Set too low, the fleet idles while clients receive 429s.

Worse, the correct value is not a property of the code. It changes with model version, hardware
generation, batch composition, driver updates, and noisy neighbours. A number tuned in March is
fiction by June.

## Decision

Do not try to know the right limit. Detect **queueing** instead, and let the limit follow.

Queueing has an unmistakable signature: short-window latency rising above long-window latency.
Little's Law gives `L = λW`, so with arrival rate roughly fixed, any growth in `W` beyond
service time _is_ queue depth. Halcyon runs a Gradient2-style controller:

```
g       = clamp(longRTT / shortRTT, 0.5, 1.0)
target  = limit × g + √limit
limit   = limit + smoothing × (target − limit)
```

- `g < 1` exactly when a queue is forming, so the limit contracts **multiplicatively** — fast,
  because queue collapse is urgent.
- When no queue is forming `g == 1` and the limit grows by `√limit`, deliberately sublinear so
  recovery probes upward gently rather than immediately re-saturating what it just rescued.
- The `0.5` floor stops one latency spike from halving the limit more than once.

This is the same family of controller as TCP congestion control, for the same reason: neither
endpoint can observe the bottleneck directly, so both infer it from delay.

Admission is then two-staged, and the order matters:

1. **Per-tenant token bucket** (fairness) — enforced first, so one customer's runaway retry
   loop is attributed to that customer rather than triggering fleet-wide shedding that
   penalises well-behaved tenants.
2. **Fleet-wide adaptive limit** (self-preservation) — enforced second, shedding in priority
   order so a `priority: 0.9` tenant survives well past where a `priority: 0.1` tenant starts
   seeing 429s.

Failed requests release their slot but are **excluded from the RTT estimate**. A fast failure
otherwise reads as a latency improvement and would make the limiter _raise_ the limit on a
system that is actively falling over.

## Consequences

The limiter is a feedback loop, and feedback loops can oscillate. Smoothing plus the
multiplicative-decrease/sublinear-increase asymmetry damps it, but the parameters are load-
bearing and should not be tuned casually.

It also cannot distinguish "the system is slow" from "the work got harder". A genuine shift to
larger requests looks like queueing and contracts the limit. That is arguably correct — fewer,
larger requests is the right response — but it is a behaviour, not an accident.

Every `Retry-After` is computed rather than constant, which turns a 429 from a dead end into an
actionable instruction and avoids synchronised retry storms.

## Alternatives considered

- **Static limit from load testing** — rejected above.
- **Queue-depth threshold** — a lagging indicator. By the time the queue is deep, the latency
  damage is already done.
- **CPU-based shedding** — measures the wrong resource entirely. An inference gateway is
  bottlenecked on accelerators it does not own.
