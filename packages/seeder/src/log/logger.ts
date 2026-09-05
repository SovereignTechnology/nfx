/**
 * Logger — the ONLY path to stdout/stderr/files in the seeder (SECURITY.md invariant 7).
 * Every message and every structured field goes through `redact()` before it reaches the
 * sink; the sink itself is injected (Node: `process.stdout.write`, tests: an array).
 *
 * There is deliberately no default global sink and no `console.*` anywhere in the package;
 * `__tests__/no-console.test.ts` enforces the latter by grepping `src/`.
 */
import { redact, redactString } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export type LogSink = (line: string, record: LogRecord) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly sink: LogSink;
  readonly level?: LogLevel;
  readonly now?: () => Date;
  readonly bindings?: LogFields;
}

function safeStringify(record: LogRecord): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({ ts: record.ts, level: record.level, msg: record.msg, fields: {} });
  }
}

class RedactingLogger implements Logger {
  private readonly sink: LogSink;
  private readonly rank: number;
  private readonly now: () => Date;
  private readonly bindings: Record<string, unknown>;

  constructor(opts: LoggerOptions) {
    this.sink = opts.sink;
    this.rank = LEVEL_RANK[opts.level ?? 'info'];
    this.now = opts.now ?? ((): Date => new Date());
    // Bindings are redacted once, at creation; they are re-emitted with every record.
    this.bindings = (redact(opts.bindings ?? {}) as Record<string, unknown> | null) ?? {};
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit('error', msg, fields);
  }

  child(bindings: LogFields): Logger {
    const level = (Object.entries(LEVEL_RANK).find(([, r]) => r === this.rank)?.[0] ??
      'info') as LogLevel;
    return new RedactingLogger({
      sink: this.sink,
      level,
      now: this.now,
      bindings: { ...this.bindings, ...bindings },
    });
  }

  private emit(level: LogLevel, msg: string, fields: LogFields | undefined): void {
    if (LEVEL_RANK[level] < this.rank) return;
    const redactedFields = redact(fields ?? {});
    const merged: Record<string, unknown> = {
      ...this.bindings,
      ...(typeof redactedFields === 'object' && redactedFields !== null
        ? (redactedFields as Record<string, unknown>)
        : { value: redactedFields }),
    };
    const record: LogRecord = {
      ts: this.now().toISOString(),
      level,
      msg: redactString(msg),
      fields: merged,
    };
    try {
      this.sink(safeStringify(record), record);
    } catch {
      // A failing sink must never take the seeder down.
    }
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return new RedactingLogger(opts);
}

/** A logger that drops everything. Handy default for library use. */
export const silentLogger: Logger = createLogger({ sink: () => undefined, level: 'error' });
