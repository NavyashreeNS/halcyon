#!/usr/bin/env node
/**
 * End-to-end check that a progressive rollout actually completes against a live fleet.
 *
 * The unit tests already prove the canary state machine is correct in isolation. What they
 * cannot prove is that the pieces are wired together — that traffic splitting reaches the
 * router, that per-version metrics are collected into the right windows, and that a verdict
 * changes what the next request is served by. That integration is exactly where this kind
 * of system breaks, so it is worth asserting on a running stack.
 *
 * Usage: node scripts/verify-rollout.mjs [--model llama-3-8b] [--timeout 180]
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (key) args.set(key, process.argv[i + 1]);
}

const GATEWAY = args.get('gateway') ?? 'http://localhost:8080';
const MODEL = args.get('model') ?? 'llama-3-8b';
const API_KEY = args.get('key') ?? 'demo-key-premium';
const TIMEOUT_MS = Number(args.get('timeout') ?? 180) * 1_000;

const sleep = (millis) => new Promise((resolve) => setTimeout(resolve, millis));

async function json(path, init) {
  const response = await fetch(`${GATEWAY}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${path} -> HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

let generating = true;

/** Background traffic. A rollout cannot be evaluated without requests to evaluate it on. */
async function generateLoad(clientId) {
  let n = 0;
  while (generating) {
    try {
      await fetch(`${GATEWAY}/v1/infer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({
          model: MODEL,
          input: `rollout verification ${clientId}/${n++}`,
          sessionKey: `verify-${clientId}-${n}`,
          deadlineMs: 4_000,
          maxOutputTokens: 96,
        }),
      });
    } catch {
      // The fleet may briefly refuse connections while a step is applied; keep going.
    }
  }
}

async function main() {
  const state = await json('/v1/control/state');
  const model = state.models.find((m) => m.modelId === MODEL);
  if (!model) throw new Error(`model '${MODEL}' is not registered`);
  if (model.versions.length < 2) {
    throw new Error(
      `model '${MODEL}' has only ${model.versions.length} version(s); ` +
        'start the stack with --canary so a second version is available',
    );
  }

  const [baselineVersion, canaryVersion] = model.versions;
  console.log(`Verifying rollout ${baselineVersion} -> ${canaryVersion} on ${MODEL}`);

  // Deliberately impatient settings. The production defaults require several minutes of
  // observation per step, which is correct in production and useless in CI.
  await json('/v1/control/rollouts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      modelId: MODEL,
      baselineVersion,
      canaryVersion,
      policy: {
        steps: [25, 100],
        healthyChecksToAdvance: 1,
        unhealthyChecksToRollback: 2,
        minimumRequests: 20,
        latencyToleranceFactor: 3,
        errorRateToleranceFactor: 3,
      },
    }),
  });

  const load = Array.from({ length: 12 }, (_, i) => generateLoad(i));
  const startedAt = Date.now();
  const seenPhases = new Set();
  let finalPhase = 'unknown';

  try {
    while (Date.now() - startedAt < TIMEOUT_MS) {
      await sleep(2_000);
      const snapshot = await json('/v1/control/state');
      const current = snapshot.models.find((m) => m.modelId === MODEL);
      const rollout = current?.rollout;
      if (!rollout) continue;

      const key = `${rollout.phase}@${rollout.canaryPercent}`;
      if (!seenPhases.has(key)) {
        seenPhases.add(key);
        console.log(
          `  [${Math.round((Date.now() - startedAt) / 1000)}s] ${rollout.phase} ` +
            `at ${rollout.canaryPercent}% (healthy streak ${rollout.healthyStreak})`,
        );
      }

      if (rollout.phase === 'promoted' || rollout.phase === 'rolled_back') {
        finalPhase = rollout.phase;
        break;
      }
    }
  } finally {
    generating = false;
    await Promise.all(load);
  }

  const history = (await json(`/v1/control/rollouts/${MODEL}/history`)).history ?? [];
  console.log(`\nDecisions recorded: ${history.length}`);
  for (const record of history.slice(-6)) {
    console.log(
      `  ${record.canaryPercent}% -> ${record.verdict.decision}` +
        `${record.verdict.reason ? ` (${record.verdict.reason})` : ''}` +
        ` | baseline p95 ${record.baseline.p95LatencyMs}ms, canary p95 ${record.canary.p95LatencyMs}ms`,
    );
  }

  if (finalPhase !== 'promoted') {
    console.error(`\nFAIL: rollout ended in '${finalPhase}', expected 'promoted'`);
    process.exit(1);
  }

  // Promotion must actually change what traffic is served by, not merely a status field.
  const finalState = await json('/v1/control/state');
  const split = finalState.models.find((m) => m.modelId === MODEL)?.split ?? [];
  const canaryShare = split.find((v) => v.version === canaryVersion)?.weight ?? 0;
  if (canaryShare < 99.9) {
    console.error(`\nFAIL: promoted, but canary carries only ${canaryShare}% of traffic`);
    process.exit(1);
  }

  console.log(`\nPASS: rollout promoted and ${canaryVersion} now serves 100% of traffic.`);
}

await main();
