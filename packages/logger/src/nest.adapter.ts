import { Logger } from './logger';

/**
 * NestJS-compatible LoggerService implementation that can be passed to
 * NestFactory.create(AppModule, { logger: new NestLoggerAdapter('api') })
 * or app.useLogger(...).
 */
export class NestLoggerAdapter {
  private logger: Logger;

  constructor(contextOrLogger?: string | Logger) {
    if (contextOrLogger instanceof Logger) {
      this.logger = contextOrLogger;
    } else {
      this.logger = new Logger(contextOrLogger);
    }
  }

  log(message: any, ...optionalParams: any[]) {
    this.logger.info(String(message), ...optionalParams);
  }

  error(message: any, ...optionalParams: any[]) {
    this.logger.error(String(message), ...optionalParams);
  }

  warn(message: any, ...optionalParams: any[]) {
    this.logger.warn(String(message), ...optionalParams);
  }

  debug(message: any, ...optionalParams: any[]) {
    this.logger.debug(String(message), ...optionalParams);
  }

  verbose(message: any, ...optionalParams: any[]) {
    this.logger.trace(String(message), ...optionalParams);
  }

  fatal(message: any, ...optionalParams: any[]) {
    this.logger.fatal(String(message), ...optionalParams);
  }
}
