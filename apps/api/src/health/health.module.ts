import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService, DatabaseService, RedisService],
  exports: [HealthService],
})
export class HealthModule {}
