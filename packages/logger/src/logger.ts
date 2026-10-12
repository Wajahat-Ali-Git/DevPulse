import { LogLevel, LOG_LEVEL_VALUES, LogContext, StructuredLogEntry, LoggerOptions } from './types';
import { redactSensitiveData } from './redact';
import { CorrelationContext } from './context';

export class Logger {
  private service: string;
  private contextName?: string;
  private minLevel: LogLevel;
  private format: 'json' | 'pretty';
  private redactKeys?: string[];

  constructor(contextOrOptions?: string | LoggerOptions) {
    if (typeof contextOrOptions === 'string') {
      this.contextName = contextOrOptions;
      this.service = process.env.SERVICE_NAME || 'devpulse';
      this.minLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
      this.format = process.env.NODE_ENV === 'production' ? 'json' : 'pretty';
    } else {
      const opts = contextOrOptions || {};
      this.service = opts.service || process.env.SERVICE_NAME || 'devpulse';
      this.contextName = opts.context;
      this.minLevel = opts.level || (process.env.LOG_LEVEL as LogLevel) || 'info';
      this.format = opts.format || (process.env.NODE_ENV === 'production' ? 'json' : 'pretty');
      this.redactKeys = opts.redactKeys;
    }
  }

  /**
   * Create a child logger with bound sub-context or service.
   */
  child(contextOrOptions: string | Partial<LoggerOptions>): Logger {
    if (typeof contextOrOptions === 'string') {
      return new Logger({
        service: this.service,
        context: this.contextName ? `${this.contextName}:${contextOrOptions}` : contextOrOptions,
        level: this.minLevel,
        format: this.format,
        redactKeys: this.redactKeys,
      });
    }

    return new Logger({
      service: contextOrOptions.service || this.service,
      context: contextOrOptions.context || this.contextName,
      level: contextOrOptions.level || this.minLevel,
      format: contextOrOptions.format || this.format,
      redactKeys: contextOrOptions.redactKeys || this.redactKeys,
    });
  }

  fatal(message: string, ...meta: unknown[]): void {
    this.writeLog('fatal', message, meta);
  }

  error(message: string, traceOrMeta?: unknown, ...meta: unknown[]): void {
    const combinedMeta = traceOrMeta !== undefined ? [traceOrMeta, ...meta] : meta;
    this.writeLog('error', message, combinedMeta);
  }

  warn(message: string, ...meta: unknown[]): void {
    this.writeLog('warn', message, meta);
  }

  info(message: string, ...meta: unknown[]): void {
    this.writeLog('info', message, meta);
  }

  debug(message: string, ...meta: unknown[]): void {
    this.writeLog('debug', message, meta);
  }

  trace(message: string, ...meta: unknown[]): void {
    this.writeLog('trace', message, meta);
  }

  // NestJS LoggerService compatibility methods
  log(message: string, ...meta: unknown[]): void {
    this.info(message, ...meta);
  }

  verbose(message: string, ...meta: unknown[]): void {
    this.trace(message, ...meta);
  }

  private shouldLog(level: LogLevel): boolean {
    const currentWeight = LOG_LEVEL_VALUES[level] ?? 30;
    const minWeight = LOG_LEVEL_VALUES[this.minLevel] ?? 30;
    return currentWeight >= minWeight;
  }

  private writeLog(level: LogLevel, rawMessage: string, rawMeta: unknown[]): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const activeContext = CorrelationContext.get();

    // Extract potential Error object or meta payload
    let errorObj: { name?: string; message: string; stack?: string } | undefined;
    let metaPayload: Record<string, unknown> = {};

    for (const item of rawMeta) {
      if (item instanceof Error) {
        errorObj = {
          name: item.name,
          message: item.message,
          stack: item.stack,
        };
      } else if (typeof item === 'string' && (item.includes('\n    at ') || item.startsWith('Error:'))) {
        // Trace string commonly passed by NestJS error handler
        errorObj = {
          name: 'Error',
          message: item.split('\n')[0],
          stack: item,
        };
      } else if (item && typeof item === 'object') {
        metaPayload = { ...metaPayload, ...(item as Record<string, unknown>) };
      } else if (item !== undefined && item !== null) {
        metaPayload.extra = item;
      }
    }

    const correlationId = (activeContext.correlationId ||
      metaPayload.correlationId ||
      activeContext.requestId ||
      metaPayload.requestId) as string | undefined;

    const requestId = (activeContext.requestId || metaPayload.requestId) as string | undefined;
    const jobId = (activeContext.jobId || metaPayload.jobId) as string | undefined;

    const entry: StructuredLogEntry = {
      timestamp,
      level,
      service: activeContext.service || this.service,
      context: this.contextName || activeContext.context,
      message: rawMessage,
    };

    if (correlationId) entry.correlationId = correlationId;
    if (requestId) entry.requestId = requestId;
    if (jobId) entry.jobId = jobId;

    const cleanMeta = { ...metaPayload };
    delete cleanMeta.correlationId;
    delete cleanMeta.requestId;
    delete cleanMeta.jobId;

    if (Object.keys(cleanMeta).length > 0) {
      entry.meta = cleanMeta;
    }

    if (errorObj) {
      entry.error = errorObj;
    }

    // Deep redact all sensitive information
    const redactedEntry = redactSensitiveData(entry, this.redactKeys);

    this.output(level, redactedEntry);
  }

  private output(level: LogLevel, entry: StructuredLogEntry): void {
    if (this.format === 'json') {
      const jsonStr = JSON.stringify(entry);
      if (level === 'error' || level === 'fatal') {
        process.stderr.write(jsonStr + '\n');
      } else {
        process.stdout.write(jsonStr + '\n');
      }
    } else {
      this.outputPretty(level, entry);
    }
  }

  private outputPretty(level: LogLevel, entry: StructuredLogEntry): void {
    const time = entry.timestamp;
    const lvl = `[${entry.level.toUpperCase()}]`.padEnd(7);
    const srv = `[${entry.service}]`;
    const ctx = entry.context ? ` [${entry.context}]` : '';
    const corr = entry.correlationId ? ` (corr:${entry.correlationId})` : '';
    const job = entry.jobId ? ` (job:${entry.jobId})` : '';
    const req = entry.requestId && !entry.correlationId ? ` (req:${entry.requestId})` : '';

    let formatted = `${time} ${lvl} ${srv}${ctx}${corr}${req}${job}: ${entry.message}`;

    if (entry.meta && Object.keys(entry.meta).length > 0) {
      formatted += `\n  Meta: ${JSON.stringify(entry.meta, null, 2)}`;
    }

    if (entry.error) {
      formatted += `\n  Error: ${entry.error.name || 'Error'}: ${entry.error.message}`;
      if (entry.error.stack) {
        formatted += `\n  Stack: ${entry.error.stack}`;
      }
    }

    if (level === 'error' || level === 'fatal') {
      console.error(formatted);
    } else if (level === 'warn') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }
}

export const logger = new Logger();
