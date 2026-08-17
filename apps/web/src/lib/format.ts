/** Presentation helpers. Kept pure and separate so they can be reasoned about on their own. */

export const gatewayUrl = (): string =>
  process.env['NEXT_PUBLIC_GATEWAY_URL'] ?? 'http://localhost:8080';

export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1_000).toFixed(0)}k`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString('en-IN');
}

export function ms(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}s`;
  if (value >= 100) return `${value.toFixed(0)}`;
  if (value >= 10) return `${value.toFixed(1)}`;
  return value.toFixed(2);
}

export function duration(totalMs: number): string {
  const seconds = Math.floor(totalMs / 1_000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Cost is carried through the whole system as integer micro-rupees; this is the only place
 * it becomes a decimal, which is exactly the point — divide once, at the very edge.
 */
export function rupees(microsInr: number): string {
  const value = microsInr / 1_000_000;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: value < 100 ? 2 : 0,
  }).format(value);
}

/** Colour is reserved for state. This maps a latency budget onto the health palette. */
export function latencyTone(value: number, budget: number): 'ok' | 'warn' | 'danger' {
  if (value <= budget * 0.6) return 'ok';
  if (value <= budget) return 'warn';
  return 'danger';
}

export const VERSION_COLOURS = ['#4c9aff', '#bc8cff', '#3fb950', '#d29922', '#f85149'];

export function versionColour(version: string, versions: string[]): string {
  const index = Math.max(0, versions.indexOf(version));
  return VERSION_COLOURS[index % VERSION_COLOURS.length]!;
}
