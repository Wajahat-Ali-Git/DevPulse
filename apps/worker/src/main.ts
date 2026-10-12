import { NestFactory } from '@nestjs/core';
import { Logger, NestLoggerAdapter } from '@devpulse/logger';
import { config, validateConfig } from '@devpulse/config';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // Validate central configuration at startup
  validateConfig();

  const workerLogger = new Logger({ service: 'worker', context: 'Bootstrap' });
  const nestLoggerAdapter = new NestLoggerAdapter(workerLogger);
  
  workerLogger.info(`Starting DevPulse Background Worker in [${config.app.nodeEnv}] environment...`, {
    environment: config.app.nodeEnv,
  });

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: nestLoggerAdapter,
  });
  app.enableShutdownHooks();

  workerLogger.info('DevPulse Background Worker started successfully.');

  const handleShutdown = async (signal: string) => {
    workerLogger.info(`Received ${signal}. Shutting down worker gracefully...`);
    await app.close();
    workerLogger.info('Worker shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('Failed to start worker application:', err);
  process.exit(1);
});
