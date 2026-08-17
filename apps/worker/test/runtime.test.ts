import { describe, expect, it } from 'vitest';
import { SimulatedRuntime } from '../src/runtimes/index.js';
import { loadWorkerConfig } from '../src/server.js';

const items = (n: number, tokens = 64) =>
  Array.from({ length: n }, (_, i) => ({
    requestId: `r${i}`,
    input: `input ${i}`,
    maxOutputTokens: tokens,
  }));

describe('SimulatedRuntime', () => {
  it('returns one result per submitted item, in order', async () => {
    const runtime = new SimulatedRuntime({ modelId: 'm', version: 'v1', kernelOverheadMs: 0 });
    const results = await runtime.execute(items(5));
    expect(results.map((r) => r.requestId)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it('amortises the fixed cost across a batch — the reason batching pays at all', async () => {
    const runtime = new SimulatedRuntime({
      modelId: 'm',
      version: 'v1',
      kernelOverheadMs: 40,
      msPerToken: 0.01,
      jitter: 0,
    });

    const singleStart = Date.now();
    await runtime.execute(items(1, 64));
    const singleMs = Date.now() - singleStart;

    const batchStart = Date.now();
    await runtime.execute(items(8, 64));
    const batchMs = Date.now() - batchStart;

    // Eight requests must cost far less than eight times one, or the whole premise is wrong.
    expect(batchMs).toBeLessThan(singleMs * 4);
  });

  it('produces version-dependent output, so a canary is genuinely distinguishable', async () => {
    const v1 = new SimulatedRuntime({ modelId: 'm', version: 'v1', kernelOverheadMs: 0 });
    const v2 = new SimulatedRuntime({ modelId: 'm', version: 'v2', kernelOverheadMs: 0 });
    const [a] = await v1.execute(items(1));
    const [b] = await v2.execute(items(1));
    expect(a!.output).not.toBe(b!.output);
    expect(a!.output).toContain('v1');
    expect(b!.output).toContain('v2');
  });

  it('is deterministic for a given seed', async () => {
    const make = () =>
      new SimulatedRuntime({ modelId: 'm', version: 'v1', kernelOverheadMs: 0, seed: 1234 });
    const first = await make().execute(items(3));
    const second = await make().execute(items(3));
    expect(first.map((r) => r.completionTokens)).toEqual(second.map((r) => r.completionTokens));
  });

  it('fails when instructed, so breaker and canary paths can be exercised', async () => {
    const runtime = new SimulatedRuntime({
      modelId: 'm',
      version: 'v1',
      kernelOverheadMs: 0,
      failureRate: 1,
    });
    await expect(runtime.execute(items(1))).rejects.toThrow(/Simulated execution failure/);
  });

  it('honours speedFactor so a fleet can contain a straggler', async () => {
    const fast = new SimulatedRuntime({
      modelId: 'm',
      version: 'v1',
      kernelOverheadMs: 60,
      jitter: 0,
      speedFactor: 3,
    });
    const slow = new SimulatedRuntime({
      modelId: 'm',
      version: 'v1',
      kernelOverheadMs: 60,
      jitter: 0,
      speedFactor: 1,
    });

    const fastStart = Date.now();
    await fast.execute(items(1));
    const fastMs = Date.now() - fastStart;

    const slowStart = Date.now();
    await slow.execute(items(1));
    const slowMs = Date.now() - slowStart;

    expect(slowMs).toBeGreaterThan(fastMs);
  });
});

describe('loadWorkerConfig', () => {
  const base = {
    PORT: '9100',
    REPLICA_ID: 'replica-a',
    ADVERTISE_ADDRESS: 'http://worker-a:9100',
    GATEWAY_URL: 'http://gateway:8080',
  } as NodeJS.ProcessEnv;

  it('derives sensible defaults from a minimal environment', () => {
    const config = loadWorkerConfig(base);
    expect(config.modelId).toBe('llama-3-8b');
    expect(config.version).toBe('v1');
    expect(config.weight).toBe(1);
  });

  it('derives a replica id from the port when none is supplied', () => {
    const { REPLICA_ID: _unused, ...withoutId } = base;
    expect(loadWorkerConfig(withoutId).replicaId).toBe('replica-9100');
  });

  it('refuses to start with an unusable advertise address', () => {
    expect(() => loadWorkerConfig({ ...base, ADVERTISE_ADDRESS: 'worker-a' })).toThrow(
      /Invalid worker configuration/,
    );
  });

  it('refuses an out-of-range failure rate', () => {
    expect(() => loadWorkerConfig({ ...base, FAILURE_RATE: '2' })).toThrow(
      /Invalid worker configuration/,
    );
  });
});
