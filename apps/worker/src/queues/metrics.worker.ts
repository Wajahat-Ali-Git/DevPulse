import { Injectable, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueName, JobName, CalculateRepositoryMetricsPayload, CalculateWorkspaceMetricsPayload } from '@devpulse/types';
import { CorrelationContext } from '@devpulse/logger';
import { RedisService } from '../redis/redis.service';
import { BaseWorker } from './base.worker';

export type MetricsJobPayload = CalculateRepositoryMetricsPayload | CalculateWorkspaceMetricsPayload;

export interface MetricsJobResult {
  success: boolean;
  jobName: string;
  calculatedAt: string;
}

@Injectable()
export class MetricsWorker extends BaseWorker<MetricsJobPayload, MetricsJobResult> implements OnModuleInit {
  protected readonly queueName = QueueName.METRICS_CALCULATION;

  constructor(redisService: RedisService) {
    super(redisService, MetricsWorker.name, { concurrency: 3 });
  }

  onModuleInit() {
    this.startWorker();
  }

  async processJob(job: Job<MetricsJobPayload, MetricsJobResult>): Promise<MetricsJobResult> {
    return CorrelationContext.run({ service: 'worker', jobId: job.id }, async () => {
      this.logger.info(`Calculating metrics for "${job.name}" [${job.id}]`, {
        jobId: job.id,
        payload: job.data,
      });

      return {
        success: true,
        jobName: job.name,
        calculatedAt: new Date().toISOString(),
      };
    });
  }
}
