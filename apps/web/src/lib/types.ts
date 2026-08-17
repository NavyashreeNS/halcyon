export interface HistogramSnapshot {
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface ReplicaView {
  id: string;
  modelId: string;
  version: string;
  address: string;
  weight: number;
  inflight: number;
  draining: boolean;
  score: number;
  ewmaLatencyMs: number;
  latency: HistogramSnapshot;
  breaker: {
    state: 'closed' | 'open' | 'half_open';
    failureRate: number;
    observations: number;
    consecutiveTrips: number;
    openDurationMs: number;
  };
  totalDispatched: number;
  totalFailed: number;
  staleForMs: number;
}

export interface BatcherView {
  queueDepth: number;
  queuedTokens: number;
  batchesFlushed: number;
  itemsFlushed: number;
  itemsRejected: number;
  meanBatchSize: number;
  flushReasons: Record<string, number>;
  queueWaitMs: HistogramSnapshot;
  batchSize: HistogramSnapshot;
  costModel: { interceptMs: number; slopeMsPerToken: number; sampleWeight: number };
}

export interface ModelView {
  modelId: string;
  versions: string[];
  split: { version: string; weight: number }[];
  rollout: {
    phase: 'idle' | 'progressing' | 'paused' | 'promoted' | 'rolled_back';
    baselineVersion: string;
    canaryVersion: string;
    canaryPercent: number;
    healthyStreak: number;
    unhealthyStreak: number;
    startedAt: number;
  } | null;
}

export interface ControlPlaneState {
  generatedAt: number;
  uptimeMs: number;
  models: ModelView[];
  replicas: ReplicaView[];
  batching: Record<string, BatcherView>;
  admission: {
    admitted: number;
    rejections: Record<string, number>;
    tenants: number;
    limiter: {
      limit: number;
      inflight: number;
      gradient: number;
      shortRttMs: number;
      longRttMs: number;
      samples: number;
    };
  };
  traffic: {
    requests: number;
    errors: number;
    shed: number;
    hedged: number;
    latency: HistogramSnapshot;
  };
}
