export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

export interface LogContext {
  service?: string;
  context?: string;
  correlationId?: string;
  requestId?: string;
  jobId?: string;
  userId?: string;
  [key: string]: unknown;
}

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  context?: string;
  message: string;
  correlationId?: string;
  requestId?: string;
  jobId?: string;
  meta?: Record<string, unknown>;
  error?: {
    name?: string;
    message: string;
    stack?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface LoggerOptions {
  service?: string;
  context?: string;
  level?: LogLevel;
  format?: 'json' | 'pretty';
  redactKeys?: string[];
}
