import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/metrics.js';
import { formatTraceparent, parseTraceparent, SpanKind, Tracer } from '../src/tracing.js';

describe('MetricsRegistry', () => {
  it('renders counters in Prometheus exposition format', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('halcyon_requests_total', 'Total requests.');
    counter.inc({ model: 'llama-3-8b', outcome: 'ok' });
    counter.inc({ model: 'llama-3-8b', outcome: 'ok' });
    counter.inc({ model: 'llama-3-8b', outcome: 'shed' });

    const output = registry.render();
    expect(output).toContain('# TYPE halcyon_requests_total counter');
    expect(output).toContain('halcyon_requests_total{model="llama-3-8b",outcome="ok"} 2');
    expect(output).toContain('halcyon_requests_total{model="llama-3-8b",outcome="shed"} 1');
  });

  it('treats label sets as order-independent', () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('c', 'help');
    counter.inc({ a: '1', b: '2' });
    counter.inc({ b: '2', a: '1' });
    expect(counter.get({ a: '1', b: '2' })).toBe(2);
  });

  it('emits cumulative histogram buckets', () => {
    const registry = new MetricsRegistry();
    const histogram = registry.histogram('latency_ms', 'Latency.', [10, 100, 1_000]);
    histogram.observe(5);
    histogram.observe(50);
    histogram.observe(5_000);

    const output = registry.render();
    // Cumulative: the 100ms bucket contains both the 5ms and 50ms observations.
    expect(output).toContain('latency_ms_bucket{le="10"} 1');
    expect(output).toContain('latency_ms_bucket{le="100"} 2');
    expect(output).toContain('latency_ms_bucket{le="1000"} 2');
    expect(output).toContain('latency_ms_bucket{le="+Inf"} 3');
    expect(output).toContain('latency_ms_count 3');
    expect(output).toContain('latency_ms_sum 5055');
  });

  it('escapes label values that would corrupt the exposition format', () => {
    const registry = new MetricsRegistry();
    registry.counter('c', 'help').inc({ path: 'a"b\\c' });
    expect(registry.render()).toContain('c{path="a\\"b\\\\c"} 1');
  });

  it('omits metrics that have never been observed', () => {
    const registry = new MetricsRegistry();
    registry.counter('never_used', 'help');
    expect(registry.render().trim()).toBe('');
  });
});

describe('trace context', () => {
  it('round-trips a traceparent header', () => {
    const context = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
    };
    expect(formatTraceparent(context)).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
    expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
  });

  it('rejects malformed, all-zero and unsupported-version headers', () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    // All-zero ids are invalid per spec; accepting them would merge unrelated traces.
    expect(parseTraceparent('00-' + '0'.repeat(32) + '-00f067aa0ba902b7-01')).toBeNull();
    expect(
      parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-' + '0'.repeat(16) + '-01'),
    ).toBeNull();
  });

  it('continues an upstream trace rather than starting a new one', () => {
    const tracer = new Tracer({ serviceName: 'test' });
    const span = tracer.startSpan(
      'inference',
      SpanKind.Server,
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
    expect(span.context.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(span.parentSpanId).toBe('00f067aa0ba902b7');
    expect(span.context.spanId).not.toBe('00f067aa0ba902b7');
  });

  it('keeps child spans inside the parent trace', () => {
    const tracer = new Tracer({ serviceName: 'test' });
    const root = tracer.startSpan('root', SpanKind.Server);
    const child = root.child('queue-wait');
    expect(child.context.traceId).toBe(root.context.traceId);
    expect(child.parentSpanId).toBe(root.context.spanId);
  });

  it('never records a span twice', () => {
    const tracer = new Tracer({ serviceName: 'test', endpoint: undefined });
    const recorded: string[] = [];
    const original = tracer.record.bind(tracer);
    tracer.record = (span) => {
      recorded.push(span.name);
      original(span);
    };
    const span = tracer.startSpan('once');
    span.end();
    span.end();
    expect(recorded).toEqual(['once']);
  });

  it('drops spans entirely when sampling is off', () => {
    const tracer = new Tracer({ serviceName: 'test', sampleRatio: 0 });
    const span = tracer.startSpan('unsampled');
    expect(span.context.traceFlags & 1).toBe(0);
  });
});
