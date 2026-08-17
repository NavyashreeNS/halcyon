import type { ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'canary' | 'neutral';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function Panel({
  title,
  note,
  action,
  flush,
  children,
}: {
  title: string;
  note?: string;
  action?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <div className="panel-title">{title}</div>
          {note ? <div className="panel-note">{note}</div> : null}
        </div>
        {action}
      </header>
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

export function Tile({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
}) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        {value}
        {unit ? <span className="tile-unit">{unit}</span> : null}
      </div>
      {sub ? <div className="tile-sub">{sub}</div> : null}
    </div>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="row">
      <span className="row-key">{label}</span>
      <span className="row-val">{value}</span>
    </div>
  );
}

export function Bar({ ratio, tone = 'info' }: { ratio: number; tone?: Tone }) {
  const colours: Record<Tone, string> = {
    ok: 'var(--ok)',
    warn: 'var(--warn)',
    danger: 'var(--danger)',
    info: 'var(--accent)',
    canary: 'var(--canary)',
    neutral: 'var(--text-dim)',
  };
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return (
    <div className="bar" role="presentation">
      <div className="bar-fill" style={{ width: `${clamped * 100}%`, background: colours[tone] }} />
    </div>
  );
}

/**
 * A bar chart of a latency distribution. Deliberately unlabelled on the y-axis: its job is
 * to make the *shape* of the distribution legible at a glance — is the tail growing? — not
 * to be read for precise values, which the p50/p95/p99 figures beside it already give.
 */
export function Distribution({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="spark" aria-hidden="true">
      {values.map((value, index) => (
        <div
          key={index}
          className="spark-bar"
          style={{ height: `${Math.max(3, (value / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
