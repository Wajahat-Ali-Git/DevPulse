import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database.service';
import { RedisService } from './redis.service';

import { HealthModule } from './health';

@Module({
  imports: [HealthModule],
  controllers: [AppController],
  providers: [AppService, DatabaseService, RedisService],
  exports: [DatabaseService, RedisService],
})
export class AppModule {}

