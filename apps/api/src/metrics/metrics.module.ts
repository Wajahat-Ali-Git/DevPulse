import { Module } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { CommitMetricsService } from './commit-metrics.service';
import { CommitMetricsController } from './commit-metrics.controller';
import { PrMetricsService } from './pr-metrics.service';
import { PrMetricsController } from './pr-metrics.controller';

@Module({
  controllers: [CommitMetricsController, PrMetricsController],
  providers: [DatabaseService, CommitMetricsService, PrMetricsService],
  exports: [CommitMetricsService, PrMetricsService],
})
export class MetricsModule {}
