import { randomBytes } from 'node:crypto';

/**
 * W3C Trace Context propagation with an OTLP/HTTP exporter.
 *
 * Traces matter more here than in an ordinary service, because a single inference request
 * has a life story worth telling: it is admitted, it waits in a queue, it is coalesced into
 * a batch with unrelated requests, it is routed to a replica, it may be hedged to a second
 * replica, and it finally returns. When p99 latency regresses, the only question that
 * matters is *which of those spans grew* — and no amount of aggregate metrics will answer
 * it, because the queue-wait and execution phases move independently.
 *
 * Implemented directly against the wire formats rather than via the OpenTelemetry SDK: the
 * traceparent header is 55 bytes of specified text and OTLP/JSON is a documented schema, so
 * the whole thing is a few hundred lines with no dependency tree on the request path. It
 * exports to any OTLP-compatible collector — Jaeger, Tempo, Honeycomb, Datadog.
 */

export interface SpanContext {
  traceId: string;
  spanId: string;
  /** Bit 0 is the `sampled` flag, per the W3C spec. */
  traceFlags: number;
}

export const SpanKind = {
  Internal: 1,
  Server: 2,
  Client: 3,
} as const;
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

export type AttributeValue = string | number | boolean;

export interface FinishedSpan {
  name: string;
  context: SpanContext;
  parentSpanId?: string;
  kind: SpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, AttributeValue>;
  status: { code: 0 | 1 | 2; message?: string };
  events: { name: string; timeUnixNano: string; attributes: Record<string, AttributeValue> }[];
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parses a `traceparent` header. Returns null for anything malformed or a future version. */
export function parseTraceparent(header: string | undefined): SpanContext | null {
  if (!header) return null;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  // All-zero ids are explicitly invalid per the spec, and accepting them would silently
  // stitch unrelated traces together.
  if (traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return null;
  return { traceId: traceId!, spanId: spanId!, traceFlags: parseInt(flags!, 16) };
}

export function formatTraceparent(context: SpanContext): string {
  const flags = context.traceFlags.toString(16).padStart(2, '0');
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

const newTraceId = (): string => randomBytes(16).toString('hex');
const newSpanId = (): string => randomBytes(8).toString('hex');

export class Span {
  readonly context: SpanContext;
  readonly attributes: Record<string, AttributeValue> = {};
  private readonly events: FinishedSpan['events'] = [];
  private status: FinishedSpan['status'] = { code: 0 };
  private readonly startMs: number;
  private ended = false;

  constructor(
    private readonly tracer: Tracer,
    readonly name: string,
    readonly kind: SpanKind,
    parent: SpanContext | null,
    readonly parentSpanId?: string,
  ) {
    this.context = {
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      traceFlags: parent?.traceFlags ?? 1,
    };
    this.startMs = Date.now();
  }

  setAttribute(key: string, value: AttributeValue): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, AttributeValue>): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  addEvent(name: string, attributes: Record<string, AttributeValue> = {}): this {
    this.events.push({ name, timeUnixNano: msToNano(Date.now()), attributes });
    return this;
  }

  setError(message: string): this {
    this.status = { code: 2, message };
    return this;
  }

  setOk(): this {
    this.status = { code: 1 };
    return this;
  }

  /** Creates a child span sharing this span's trace. */
  child(name: string, kind: SpanKind = SpanKind.Internal): Span {
    return new Span(this.tracer, name, kind, this.context, this.context.spanId);
  }

  end(): void {
    // Ending a span twice would double-count it in every latency aggregate downstream.
    if (this.ended) return;
    this.ended = true;
    this.tracer.record({
      name: this.name,
      context: this.context,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      kind: this.kind,
      startTimeUnixNano: msToNano(this.startMs),
      endTimeUnixNano: msToNano(Date.now()),
      attributes: this.attributes,
      status: this.status,
      events: this.events,
    });
  }

  get durationMs(): number {
    return Date.now() - this.startMs;
  }
}

export interface TracerOptions {
  serviceName: string;
  serviceVersion?: string;
  /** OTLP/HTTP traces endpoint. When absent, spans are buffered and never shipped. */
  endpoint?: string;
  /** Head-based sampling ratio in [0, 1]. */
  sampleRatio?: number;
  /** Spans are flushed when this many accumulate, or on the flush interval. */
  batchSize?: number;
  flushIntervalMs?: number;
}

export class Tracer {
  private buffer: FinishedSpan[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly sampleRatio: number;
  private readonly batchSize: number;
  private dropped = 0;

  constructor(private readonly options: TracerOptions) {
    this.sampleRatio = options.sampleRatio ?? 1;
    this.batchSize = options.batchSize ?? 256;
    if (options.endpoint) {
      this.timer = setInterval(() => void this.flush(), options.flushIntervalMs ?? 5_000);
      this.timer.unref();
    }
  }

  /**
   * Starts a span, continuing an upstream trace when a valid `traceparent` is supplied.
   *
   * Sampling is head-based and decided once per trace, then propagated: sampling each span
   * independently would produce traces with holes in them, which are worse than useless
   * because the gaps look like latency.
   */
  startSpan(name: string, kind: SpanKind = SpanKind.Internal, traceparent?: string): Span {
    const parent = parseTraceparent(traceparent);
    if (parent) {
      return new Span(this, name, kind, parent, parent.spanId);
    }
    const sampled = Math.random() < this.sampleRatio;
    return new Span(this, name, kind, {
      traceId: newTraceId(),
      spanId: '',
      traceFlags: sampled ? 1 : 0,
    });
  }

  record(span: FinishedSpan): void {
    if ((span.context.traceFlags & 1) === 0) return;
    // Bound the buffer: a collector outage must not turn into an out-of-memory crash in the
    // gateway. Dropping the oldest spans and counting the loss is the safe failure mode.
    if (this.buffer.length >= this.batchSize * 4) {
      this.buffer.shift();
      this.dropped += 1;
    }
    this.buffer.push(span);
    if (this.buffer.length >= this.batchSize) void this.flush();
  }

  /** Ships buffered spans as OTLP/JSON. Failures are swallowed — telemetry must never page. */
  async flush(): Promise<void> {
    if (!this.options.endpoint || this.buffer.length === 0) return;
    const spans = this.buffer;
    this.buffer = [];
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              attr('service.name', this.options.serviceName),
              attr('service.version', this.options.serviceVersion ?? '0.0.0'),
            ],
          },
          scopeSpans: [
            {
              scope: { name: '@halcyon/telemetry', version: '0.1.0' },
              spans: spans.map((s) => ({
                traceId: s.context.traceId,
                spanId: s.context.spanId,
                parentSpanId: s.parentSpanId ?? '',
                name: s.name,
                kind: s.kind,
                startTimeUnixNano: s.startTimeUnixNano,
                endTimeUnixNano: s.endTimeUnixNano,
                attributes: Object.entries(s.attributes).map(([k, v]) => attr(k, v)),
                status: s.status,
                events: s.events.map((e) => ({
                  name: e.name,
                  timeUnixNano: e.timeUnixNano,
                  attributes: Object.entries(e.attributes).map(([k, v]) => attr(k, v)),
                })),
              })),
            },
          ],
        },
      ],
    };

    try {
      await fetch(this.options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // An unreachable collector is not an application error. Losing the spans is the
      // correct trade: the alternative is retry queues that grow without bound.
      this.dropped += spans.length;
    }
  }

  get droppedSpans(): number {
    return this.dropped;
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

const msToNano = (ms: number): string => `${BigInt(Math.round(ms)) * 1_000_000n}`;

function attr(key: string, value: AttributeValue) {
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}
