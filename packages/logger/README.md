# @devpulse/logger

Structured, context-aware, and secure logging package for DevPulse API, background workers, and shared modules.

## Features

- **Structured Output**: Consistent JSON logs in production (`NODE_ENV=production`) and human-readable formatted logs in local development.
- **Log Levels**: Standard levels (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) with level filtering via `LOG_LEVEL`.
- **Automatic Timestamps & Metadata**: Every log includes ISO-8601 timestamp, service name, context, level, and message.
- **Correlation & Context Tracing**: Built-in support for request correlation IDs (`x-correlation-id`, `x-request-id`) and worker job IDs (`jobId`) via Node.js `AsyncLocalStorage`.
- **Sensitive Data Redaction**: Automatic deep redaction of passwords, tokens, API keys, secrets, authorization headers, cookies, etc.
- **NestJS Integration**: `NestLoggerAdapter` for plug-and-play drop-in replacement into NestJS `app.useLogger()`.
- **Express / NestJS Middleware**: `createCorrelationMiddleware` to automatically extract/generate correlation IDs and log incoming/outgoing HTTP requests.

## Usage

### Basic Usage

```typescript
import { Logger } from '@devpulse/logger';

const logger = new Logger({ service: 'api', context: 'UserService' });

logger.info('User authenticated successfully', {
  userId: 'usr_123',
  token: 'super_secret_token', // automatically redacted to [REDACTED]
});
```

### NestJS Bootstrap Integration

```typescript
import { NestFactory } from '@nestjs/core';
import { NestLoggerAdapter } from '@devpulse/logger';
import { AppModule } from './app.module';

async function bootstrap() {
  const nestLogger = new NestLoggerAdapter({ service: 'api', context: 'Bootstrap' });
  const app = await NestFactory.create(AppModule, { logger: nestLogger });
  // ...
}
```

### HTTP Correlation Middleware

```typescript
import { createCorrelationMiddleware } from '@devpulse/logger';

app.use(createCorrelationMiddleware({ serviceName: 'api' }));
```

### Background Worker Context Propagation

```typescript
import { Logger, CorrelationContext } from '@devpulse/logger';

const logger = new Logger({ service: 'worker', context: 'JobProcessor' });

await CorrelationContext.run({ jobId: job.id, correlationId: job.data.correlationId }, async () => {
  logger.info(`Starting job ${job.name}`);
  // all subsequent logs inside this context automatically carry jobId and correlationId
});
```
