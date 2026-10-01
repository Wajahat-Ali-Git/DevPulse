export class Logger {
  constructor(private context?: string) {}

  info(message: string, ...meta: any[]): void {
    console.log(`[INFO]${this.formatContext()} ${message}`, ...meta);
  }

  warn(message: string, ...meta: any[]): void {
    console.warn(`[WARN]${this.formatContext()} ${message}`, ...meta);
  }

  error(message: string, trace?: string, ...meta: any[]): void {
    console.error(`[ERROR]${this.formatContext()} ${message}`, trace ? `\nTrace: ${trace}` : '', ...meta);
  }

  debug(message: string, ...meta: any[]): void {
    console.debug(`[DEBUG]${this.formatContext()} ${message}`, ...meta);
  }

  private formatContext(): string {
    return this.context ? ` [${this.context}]` : '';
  }
}

export const logger = new Logger('App');
