/**
 * Structured JSON logging with trace correlation.
 *
 * Every line carries `traceId` and `spanId` when they are available, which is what turns
 * logs and traces into one navigable artifact instead of two disconnected ones: find a slow
 * trace in the UI, pivot to exactly the log lines that request emitted.
 *
 * Output goes to stdout as newline-delimited JSON — the shape every log shipper already
 * understands, and the shape a container runtime already collects.
 */
export const LogLevel = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;
export type LogLevelName = keyof typeof LogLevel;

export interface LoggerOptions {
  service: string;
  level?: LogLevelName;
  /** Redacted before serialisation. Defaults cover the usual credential-bearing fields. */
  redact?: string[];
}

const DEFAULT_REDACT = ['authorization', 'apiKey', 'api_key', 'password', 'token', 'secret'];

export class Logger {
  private readonly threshold: number;
  private readonly redact: Set<string>;

  constructor(
    private readonly options: LoggerOptions,
    /** Fields stamped onto every line this logger emits. See {@link child}. */
    private readonly bound: Record<string, unknown> = {},
  ) {
    this.threshold = LogLevel[options.level ?? 'info'];
    this.redact = new Set((options.redact ?? DEFAULT_REDACT).map((k) => k.toLowerCase()));
  }

  private write(level: LogLevelName, message: string, fields: Record<string, unknown>): void {
    if (LogLevel[level] < this.threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      service: this.options.service,
      msg: message,
      ...this.sanitise({ ...this.bound, ...fields }),
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }

  private sanitise(fields: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      output[key] = this.redact.has(key.toLowerCase()) ? '[redacted]' : value;
    }
    return output;
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write('error', message, fields);
  }

  /**
   * Returns a logger that stamps `fields` onto every subsequent line. Used to bind
   * `requestId`, `traceId` and `tenantId` once at the top of a request rather than
   * threading them through every call site.
   */
  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.options, { ...this.bound, ...fields });
  }
}
