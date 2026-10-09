import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as DevPulseLogger } from '@devpulse/logger';
import { config, validateConfig } from '@devpulse/config';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  // Validate central configuration at startup
  validateConfig();

  const nestLogger = new NestLogger('WorkerMain');
  const sharedLogger = new DevPulseLogger('Worker');
  
  nestLogger.log(`Starting DevPulse Background Worker in [${config.app.nodeEnv}] environment...`);
  sharedLogger.info('Shared logger initialized for worker');

  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  nestLogger.log('DevPulse Background Worker started successfully.');

  const handleShutdown = async (signal: string) => {
    nestLogger.log(`Received ${signal}. Shutting down worker gracefully...`);
    await app.close();
    nestLogger.log('Worker shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('Failed to start worker application:', err);
  process.exit(1);
});
