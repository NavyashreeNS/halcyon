#!/usr/bin/env node
/**
 * Boots a complete local fleet: one gateway plus a heterogeneous set of workers.
 *
 * The workers are deliberately *not* identical. One is fast, one is a 0.6x straggler, and
 * one serves a different model version. A homogeneous fleet makes a load balancer look good
 * no matter how naive it is — imbalance is the only condition under which routing decisions
 * are observable at all.
 *
 * Usage:
 *   node scripts/dev-stack.mjs           # gateway + 2x v1 workers
 *   node scripts/dev-stack.mjs --canary  # also starts a v2 worker for rollout demos
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const withCanary = process.argv.includes('--canary');

const GATEWAY_DIST = 'apps/gateway/dist/server.js';
const WORKER_DIST = 'apps/worker/dist/server.js';

for (const file of [GATEWAY_DIST, WORKER_DIST]) {
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run \`npm run build\` first.`);
    process.exit(1);
  }
}

const children = [];

function start(name, script, env) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = name.padEnd(12);
  child.stdout.on('data', (chunk) => process.stdout.write(prefixLines(prefix, chunk)));
  child.stderr.on('data', (chunk) => process.stderr.write(prefixLines(prefix, chunk)));
  child.on('exit', (code) => {
    console.log(`${prefix} exited with code ${code}`);
  });
  children.push(child);
  return child;
}

const prefixLines = (prefix, chunk) =>
  chunk
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => `${prefix} | ${line}\n`)
    .join('');

start('gateway', GATEWAY_DIST, { PORT: '8080' });

// Workers are started after a short delay purely to keep the log readable; the retry loop
// in the worker means correctness does not depend on ordering.
setTimeout(() => {
  start('worker-a', WORKER_DIST, {
    PORT: '9101',
    REPLICA_ID: 'replica-a',
    MODEL_ID: 'llama-3-8b',
    MODEL_VERSION: 'v1',
    ADVERTISE_ADDRESS: 'http://localhost:9101',
    GATEWAY_URL: 'http://localhost:8080',
    ACCELERATOR: 'a10g',
  });
  start('worker-b', WORKER_DIST, {
    PORT: '9102',
    REPLICA_ID: 'replica-b',
    MODEL_ID: 'llama-3-8b',
    MODEL_VERSION: 'v1',
    ADVERTISE_ADDRESS: 'http://localhost:9102',
    GATEWAY_URL: 'http://localhost:8080',
    ACCELERATOR: 'a10g',
    // A deliberate straggler, so the router has an imbalance to correct.
    SPEED_FACTOR: '0.6',
  });
  if (withCanary) {
    start('worker-c', WORKER_DIST, {
      PORT: '9103',
      REPLICA_ID: 'replica-c',
      MODEL_ID: 'llama-3-8b',
      MODEL_VERSION: 'v2',
      ADVERTISE_ADDRESS: 'http://localhost:9103',
      GATEWAY_URL: 'http://localhost:8080',
      ACCELERATOR: 'h100',
      SPEED_FACTOR: '1.4',
      REPLICA_WEIGHT: '2',
    });
  }
}, 1_500);

const shutdown = () => {
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(
  `Halcyon dev stack starting.\n` +
    `  gateway   http://localhost:8080\n` +
    `  metrics   http://localhost:8080/metrics\n` +
    `  state     http://localhost:8080/v1/control/state\n` +
    (withCanary ? `  canary    llama-3-8b@v2 on :9103\n` : '') +
    `\nPress Ctrl+C to stop.\n`,
);
