/**
 * A minimal Prometheus-compatible metrics registry.
 *
 * Deliberately dependency-free. The Prometheus exposition format is a stable, documented
 * text protocol, and implementing it directly costs ~150 lines while removing a transitive
 * dependency tree from a process that sits on the request path. It also keeps the histogram
 * implementation honest: these are cumulative bucket counts, which is what Prometheus
 * expects and what makes `histogram_quantile()` work correctly across a scrape window.
 */

type Labels = Record<string, string>;

const escapeLabelValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

const renderLabels = (labels: Labels): string => {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
};

/** Label sets are keyed by a canonical, order-independent serialisation. */
const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  abstract render(): string[];
  protected header(type: string): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${type}`];
  }
}

export class Counter extends Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  inc(labels: Labels = {}, delta = 1): void {
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing) existing.value += delta;
    else this.values.set(key, { labels, value: delta });
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels))?.value ?? 0;
  }

  override render(): string[] {
    if (this.values.size === 0) return [];
    return [
      ...this.header('counter'),
      ...[...this.values.values()].map((v) => `${this.name}${renderLabels(v.labels)} ${v.value}`),
    ];
  }
}

export class Gauge extends Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), { labels, value });
  }

  override render(): string[] {
    if (this.values.size === 0) return [];
    return [
      ...this.header('gauge'),
      ...[...this.values.values()].map((v) => `${this.name}${renderLabels(v.labels)} ${v.value}`),
    ];
  }
}

/**
 * Explicit-bucket histogram. Buckets are cumulative (`le` = less-or-equal), which is what
 * lets Prometheus interpolate quantiles server-side and aggregate across instances — a
 * property pre-computed per-instance quantiles do not have.
 */
export class Histogram extends Metric {
  private readonly series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();

  constructor(
    name: string,
    help: string,
    readonly buckets: number[] = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000],
  ) {
    super(name, help);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) entry.counts[i] = (entry.counts[i] ?? 0) + 1;
    }
  }

  override render(): string[] {
    if (this.series.size === 0) return [];
    const lines = this.header('histogram');
    for (const entry of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const labels = { ...entry.labels, le: String(this.buckets[i]) };
        lines.push(`${this.name}_bucket${renderLabels(labels)} ${entry.counts[i] ?? 0}`);
      }
      lines.push(
        `${this.name}_bucket${renderLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`,
      );
      lines.push(`${this.name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
    return lines;
  }
}

export class MetricsRegistry {
  private readonly metrics: Metric[] = [];

  counter(name: string, help: string): Counter {
    const metric = new Counter(name, help);
    this.metrics.push(metric);
    return metric;
  }

  gauge(name: string, help: string): Gauge {
    const metric = new Gauge(name, help);
    this.metrics.push(metric);
    return metric;
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    const metric = new Histogram(name, help, buckets);
    this.metrics.push(metric);
    return metric;
  }

  /** Renders the full registry in Prometheus text exposition format. */
  render(): string {
    return this.metrics.flatMap((m) => m.render()).join('\n') + '\n';
  }

  get contentType(): string {
    return 'text/plain; version=0.0.4; charset=utf-8';
  }
}
