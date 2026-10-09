import { NestFactory } from '@nestjs/core';
import { config, validateConfig } from '@devpulse/config';
import { AppModule } from './app.module';

async function bootstrap() {
  // Validate central configuration at startup
  validateConfig();

  const app = await NestFactory.create(AppModule);

  // Configure CORS
  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Configure Global API Prefix
  app.setGlobalPrefix('api/v1');

  const port = config.app.port;
  await app.listen(port);
  console.log(`DevPulse API running in [${config.app.nodeEnv}] on: http://localhost:${port}/api/v1`);
}

bootstrap();

