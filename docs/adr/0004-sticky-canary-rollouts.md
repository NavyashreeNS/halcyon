# ADR 0004 — Hash-sticky traffic splitting and SLO-gated rollout

**Status:** Accepted · **Date:** 2026-01-17

## Context

Shipping a new model version is riskier than shipping new code. Code either works or throws; a
model can be flawless by every infrastructure metric while being materially worse at its job.
The damage is proportional to how much traffic saw it, so the goal is not to avoid bad versions
— it is to **bound the blast radius** of one.

Two design questions follow: how traffic is assigned to versions, and what evidence justifies
increasing the canary's share.

## Decision

### Assignment: hash a stable key

The obvious implementation, `Math.random() < canaryWeight`, is wrong in a way that only appears
in production. A user session makes many requests; independent coin flips send them to
different model versions, so the user sees a conversation whose voice changes mid-thread, and
every per-session metric becomes a blend of both arms — destroying the comparison the canary
exists to make.

Halcyon hashes a stable key (session, user, conversation) with FNV-1a and maps it onto `[0, 1)`.
This gives stickiness for free with **no shared state between gateway instances**: every
instance computes the same answer from the same key. Because ramping only ever widens the
canary's interval, users already on the canary stay on it as the rollout progresses. A
per-rollout salt keeps concurrent experiments from correlating.

### Promotion: streaks against a concurrent baseline

The canary is compared against the baseline **running at the same time on the same fleet**.
Comparing against a historical baseline is the classic mistake — it confounds the version
change with time of day, traffic mix, and neighbouring load.

Three guards prevent the two ways this goes wrong in practice:

- **Minimum request count.** At 1% traffic a window might contain eight requests; two unlucky
  failures read as a 25% error rate. Below the threshold the controller holds.
- **Relative _and_ absolute error tolerance.** Pure ratios are unusable against a healthy
  baseline, where any error at all is an infinite regression.
- **Consecutive-observation streaks, in both directions.** One bad window is a blip; _n_ in a
  row is a trend. Requiring streaks to advance _and_ to roll back makes the controller hard to
  flip on a single unlucky sample either way.

A window with insufficient data touches **neither** streak. Letting it reset the healthy streak
would stall low-traffic rollouts forever; letting it reset the unhealthy streak would let a
real regression hide behind intermittent quiet periods.

Rollback is always immediate and always to 0%. There is no partial retreat: a version suspected
of harming users should stop reaching them at once.

## Consequences

Separating _judging a window_ (a statistical question) from _deciding what to do about it_ (a
policy question) was not the first design. Conflating them produced a controller that read
`healthyStreak` but never incremented it, so healthy rollouts could never advance — a bug that
unit tests caught precisely because the two concerns were eventually split apart.

Hash-based assignment means the realised split only approaches the configured one in
expectation. At 50,000 keys a 10% canary lands within ±1%; at a few hundred keys it will not,
which is another reason the minimum-request guard exists.

The controller judges _operational_ health — errors and latency. It cannot tell that a model
has become subtly less helpful. Quality evaluation is a separate discipline and deliberately
out of scope here; this system bounds exposure so that a human evaluation has time to run.

## Alternatives considered

- **Random assignment per request** — rejected above.
- **Sticky sessions in a shared store (Redis)** — correct, but adds a network hop and a hard
  dependency to the request path to reproduce what a hash function does for free.
- **Automatic promotion on a fixed schedule** — time is not evidence.
