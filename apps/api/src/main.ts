import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { config, validateConfig } from '@devpulse/config';
import { NestLoggerAdapter, Logger, createCorrelationMiddleware } from '@devpulse/logger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common';

async function bootstrap() {
  // Validate central configuration at startup
  validateConfig();

  const apiLogger = new Logger({ service: 'api', context: 'Bootstrap' });
  const nestLogger = new NestLoggerAdapter(apiLogger);

  const app = await NestFactory.create(AppModule, {
    logger: nestLogger,
  });

  // Attach Correlation and Request Tracing Middleware
  app.use(createCorrelationMiddleware({ serviceName: 'api' }));

  // Configure CORS
  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Configure Global API Prefix
  app.setGlobalPrefix('api/v1');

  // Configure Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // Configure Global Exception Filter
  app.useGlobalFilters(new GlobalExceptionFilter());

  const port = config.app.port;
  await app.listen(port);
  apiLogger.info(`DevPulse API running in [${config.app.nodeEnv}] on: http://localhost:${port}/api/v1`, {
    port,
    environment: config.app.nodeEnv,
  });
}

bootstrap();

