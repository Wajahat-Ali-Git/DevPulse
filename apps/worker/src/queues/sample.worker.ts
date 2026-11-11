import { Injectable, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueName, JobName, SampleJobPayload } from '@devpulse/types';
import { CorrelationContext } from '@devpulse/logger';
import { RedisService } from '../redis/redis.service';
import { BaseWorker } from './base.worker';

export interface SampleWorkerJobResult {
  success: boolean;
  message: string;
  processedAt: string;
}

@Injectable()
export class SampleWorker extends BaseWorker<SampleJobPayload, SampleWorkerJobResult> implements OnModuleInit {
  protected readonly queueName = QueueName.SAMPLE;

  constructor(redisService: RedisService) {
    super(redisService, SampleWorker.name, { concurrency: 2 });
  }

  onModuleInit() {
    this.startWorker();
  }

  async processJob(job: Job<SampleJobPayload, SampleWorkerJobResult>): Promise<SampleWorkerJobResult> {
    return CorrelationContext.run({ service: 'worker', jobId: job.id }, async () => {
      this.logger.info(`SampleWorker processing job ${job.id}: ${job.data?.message}`, {
        jobId: job.id,
        payload: job.data,
      });

      return {
        success: true,
        message: job.data?.message ?? 'done',
        processedAt: new Date().toISOString(),
      };
    });
  }
}
