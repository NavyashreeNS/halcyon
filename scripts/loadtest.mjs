#!/usr/bin/env node
/**
 * Closed-loop load generator for a running Halcyon stack.
 *
 * Deliberately closed-loop (a fixed number of virtual clients, each waiting for its previous
 * response before issuing the next) rather than open-loop. An open-loop generator that fires
 * at a fixed rate regardless of responses will happily queue millions of requests against a
 * struggling system and report latencies that describe the generator's own backlog rather
 * than the server's behaviour. Closed-loop applies genuine backpressure, which is what a
 * real client fleet does.
 *
 * Usage:
 *   node scripts/loadtest.mjs --clients 32 --seconds 20 --model llama-3-8b
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (key) args.set(key, process.argv[i + 1]);
}

const GATEWAY = args.get('gateway') ?? 'http://localhost:8080';
const API_KEY = args.get('key') ?? 'demo-key-premium';
const MODEL = args.get('model') ?? 'llama-3-8b';
const CLIENTS = Number(args.get('clients') ?? 24);
const SECONDS = Number(args.get('seconds') ?? 15);
const DEADLINE_MS = Number(args.get('deadline') ?? 2000);

const latencies = [];
const outcomes = new Map();
const versions = new Map();
const batchSizes = [];
let done = false;

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

async function client(id) {
  let n = 0;
  while (!done) {
    const startedAt = Date.now();
    try {
      const response = await fetch(`${GATEWAY}/v1/infer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({
          model: MODEL,
          input: `load test client ${id} request ${n++}`,
          sessionKey: `client-${id}`,
          deadlineMs: DEADLINE_MS,
          maxOutputTokens: 64 + ((id * 7 + n) % 192),
        }),
      });
      const elapsed = Date.now() - startedAt;
      if (response.ok) {
        const body = await response.json();
        latencies.push(elapsed);
        batchSizes.push(body.batch.size);
        bump(outcomes, 'ok');
        bump(versions, body.version);
      } else {
        const body = await response.json().catch(() => ({}));
        bump(outcomes, body?.error?.code ?? `http_${response.status}`);
      }
    } catch (error) {
      bump(outcomes, error.name === 'TimeoutError' ? 'timeout' : 'network_error');
    }
  }
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

async function main() {
  console.log(
    `Load test -> ${GATEWAY}\n` +
      `  model=${MODEL} clients=${CLIENTS} duration=${SECONDS}s deadline=${DEADLINE_MS}ms\n`,
  );

  const startedAt = Date.now();
  const workers = Array.from({ length: CLIENTS }, (_, i) => client(i));
  setTimeout(() => {
    done = true;
  }, SECONDS * 1000);
  await Promise.all(workers);

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const total = [...outcomes.values()].reduce((sum, n) => sum + n, 0);
  const meanBatch =
    batchSizes.length === 0 ? 0 : batchSizes.reduce((s, n) => s + n, 0) / batchSizes.length;

  console.log('Results');
  console.log(`  requests        ${total}`);
  console.log(`  throughput      ${(total / elapsedSeconds).toFixed(1)} req/s`);
  console.log(`  success rate    ${(((outcomes.get('ok') ?? 0) / total) * 100).toFixed(2)}%`);
  console.log(
    `  p50 / p95 / p99 ${quantile(sorted, 0.5)} / ${quantile(sorted, 0.95)} / ${quantile(sorted, 0.99)} ms`,
  );
  console.log(`  mean batch size ${meanBatch.toFixed(2)}`);
  console.log('  outcomes');
  for (const [code, count] of [...outcomes].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${code.padEnd(22)} ${count}`);
  }
  if (versions.size > 1) {
    console.log('  version split');
    for (const [version, count] of [...versions].sort((a, b) => b[1] - a[1])) {
      const share = ((count / (outcomes.get('ok') ?? 1)) * 100).toFixed(1);
      console.log(`    ${version.padEnd(22)} ${count} (${share}%)`);
    }
  }

  // A load test that cannot fail is a demo. Exiting non-zero on a bad success rate makes
  // this usable as a CI gate.
  const successRate = (outcomes.get('ok') ?? 0) / Math.max(1, total);
  if (successRate < 0.95) {
    console.error(`\nFAIL: success rate ${(successRate * 100).toFixed(2)}% is below 95%`);
    process.exit(1);
  }
}

await main();
