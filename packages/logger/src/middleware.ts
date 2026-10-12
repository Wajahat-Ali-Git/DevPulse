import { randomUUID } from 'crypto';
import { CorrelationContext } from './context';
import { Logger } from './logger';

export interface CorrelationMiddlewareOptions {
  serviceName?: string;
  headerName?: string;
  logger?: Logger;
}

/**
 * Express / NestJS middleware to extract or generate correlation ID (x-correlation-id / x-request-id),
 * attach it to AsyncLocalStorage context and response headers, and log incoming request / response completion.
 */
export function createCorrelationMiddleware(options: CorrelationMiddlewareOptions = {}) {
  const headerName = (options.headerName || 'x-correlation-id').toLowerCase();
  const serviceName = options.serviceName || process.env.SERVICE_NAME || 'api';
  const reqLogger = options.logger || new Logger({ service: serviceName, context: 'HTTP' });

  return (req: any, res: any, next: () => void) => {
    const correlationId =
      (req.headers[headerName] as string) ||
      (req.headers['x-request-id'] as string) ||
      randomUUID();

    const requestId = randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('x-request-id', requestId);

    const startTime = Date.now();

    CorrelationContext.run(
      {
        service: serviceName,
        correlationId,
        requestId,
      },
      () => {
        reqLogger.info(`Incoming ${req.method} ${req.originalUrl || req.url}`, {
          method: req.method,
          url: req.originalUrl || req.url,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });

        res.on('finish', () => {
          const durationMs = Date.now() - startTime;
          const statusCode = res.statusCode;
          const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

          if (level === 'error') {
            reqLogger.error(
              `Completed ${req.method} ${req.originalUrl || req.url} with ${statusCode} in ${durationMs}ms`,
              { statusCode, durationMs }
            );
          } else if (level === 'warn') {
            reqLogger.warn(
              `Completed ${req.method} ${req.originalUrl || req.url} with ${statusCode} in ${durationMs}ms`,
              { statusCode, durationMs }
            );
          } else {
            reqLogger.info(
              `Completed ${req.method} ${req.originalUrl || req.url} with ${statusCode} in ${durationMs}ms`,
              { statusCode, durationMs }
            );
          }
        });

        next();
      }
    );
  };
}
