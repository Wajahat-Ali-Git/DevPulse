import { Module } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { CommitMetricsService } from './commit-metrics.service';
import { CommitMetricsController } from './commit-metrics.controller';

@Module({
  controllers: [CommitMetricsController],
  providers: [DatabaseService, CommitMetricsService],
  exports: [CommitMetricsService],
})
export class MetricsModule {}
