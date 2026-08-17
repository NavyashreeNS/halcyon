import { describe, expect, it } from 'vitest';
import {
  ERROR_STATUS,
  InferenceRequestSchema,
  RolloutRequestSchema,
  WorkerRegistrationSchema,
} from '../src/index.js';

describe('InferenceRequestSchema', () => {
  it('applies defaults so a minimal request is still fully specified', () => {
    const parsed = InferenceRequestSchema.parse({ model: 'llama-3-8b', input: 'hello' });
    expect(parsed.deadlineMs).toBe(2_000);
    expect(parsed.lane).toBe('interactive');
    expect(parsed.maxOutputTokens).toBe(256);
  });

  it('rejects a deadline too short to be meaningful', () => {
    const result = InferenceRequestSchema.safeParse({
      model: 'm',
      input: 'x',
      deadlineMs: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unbounded deadline that would opt out of scheduling protections', () => {
    const result = InferenceRequestSchema.safeParse({
      model: 'm',
      input: 'x',
      deadlineMs: 24 * 60 * 60 * 1000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty model or input rather than passing them to the scheduler', () => {
    expect(InferenceRequestSchema.safeParse({ model: '', input: 'x' }).success).toBe(false);
    expect(InferenceRequestSchema.safeParse({ model: 'm', input: '' }).success).toBe(false);
  });

  it('accepts only the two known lanes', () => {
    expect(InferenceRequestSchema.safeParse({ model: 'm', input: 'x', lane: 'bulk' }).success).toBe(
      true,
    );
    expect(
      InferenceRequestSchema.safeParse({ model: 'm', input: 'x', lane: 'urgent' }).success,
    ).toBe(false);
  });
});

describe('WorkerRegistrationSchema', () => {
  it('requires an address the gateway can actually dial', () => {
    const base = {
      replicaId: 'r1',
      modelId: 'm',
      version: 'v1',
      address: 'not-a-url',
    };
    expect(WorkerRegistrationSchema.safeParse(base).success).toBe(false);
    expect(
      WorkerRegistrationSchema.safeParse({ ...base, address: 'http://worker-a:9100' }).success,
    ).toBe(true);
  });

  it('rejects a non-positive weight, which would divide by zero when scoring', () => {
    const result = WorkerRegistrationSchema.safeParse({
      replicaId: 'r1',
      modelId: 'm',
      version: 'v1',
      address: 'http://w:9100',
      weight: 0,
    });
    expect(result.success).toBe(false);
  });

  it('defaults batch limits so a worker need only declare its identity', () => {
    const parsed = WorkerRegistrationSchema.parse({
      replicaId: 'r1',
      modelId: 'm',
      version: 'v1',
      address: 'http://w:9100',
    });
    expect(parsed.weight).toBe(1);
    expect(parsed.maxBatchSize).toBe(32);
    expect(parsed.maxBatchTokens).toBe(16_384);
  });
});

describe('RolloutRequestSchema', () => {
  it('requires both versions to be named explicitly', () => {
    expect(RolloutRequestSchema.safeParse({ modelId: 'm', baselineVersion: 'v1' }).success).toBe(
      false,
    );
  });

  it('accepts a partial policy override', () => {
    const parsed = RolloutRequestSchema.parse({
      modelId: 'm',
      baselineVersion: 'v1',
      canaryVersion: 'v2',
      policy: { steps: [10, 100], minimumRequests: 50 },
    });
    expect(parsed.policy?.steps).toEqual([10, 100]);
    expect(parsed.policy?.latencyToleranceFactor).toBeUndefined();
  });

  it('rejects a traffic step outside 0-100', () => {
    const result = RolloutRequestSchema.safeParse({
      modelId: 'm',
      baselineVersion: 'v1',
      canaryVersion: 'v2',
      policy: { steps: [10, 150] },
    });
    expect(result.success).toBe(false);
  });
});

describe('ERROR_STATUS', () => {
  it('maps every error code to a sensible HTTP status', () => {
    // Quota exhaustion is the client's fault and retryable; overload is ours.
    expect(ERROR_STATUS.quota_exceeded).toBe(429);
    expect(ERROR_STATUS.overloaded).toBe(503);
    expect(ERROR_STATUS.deadline_unreachable).toBe(503);
    expect(ERROR_STATUS.unauthorized).toBe(401);
    expect(ERROR_STATUS.model_not_found).toBe(404);
    expect(ERROR_STATUS.invalid_request).toBe(400);
  });

  it('never maps a shed reason to a 2xx or a non-retryable 4xx', () => {
    for (const code of [
      'overloaded',
      'queue_full',
      'deadline_unreachable',
      'no_capacity',
    ] as const) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(500);
    }
  });
});
