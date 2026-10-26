import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database.service';
import { RedisService } from './redis.service';

import { HealthModule } from './health';
import { AuthModule, AuthMiddleware, JwtAuthGuard, RolesGuard } from './auth';

@Module({
  imports: [HealthModule, AuthModule],
  controllers: [AppController],
  providers: [
    AppService,
    DatabaseService,
    RedisService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
  exports: [DatabaseService, RedisService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}

