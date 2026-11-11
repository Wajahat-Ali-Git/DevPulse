import { Injectable, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueName, JobName, SyncUserRepositoriesPayload, SyncSingleRepositoryPayload } from '@devpulse/types';
import { CorrelationContext } from '@devpulse/logger';
import { RedisService } from '../redis/redis.service';
import { BaseWorker } from './base.worker';

export type RepositorySyncJobPayload = SyncUserRepositoriesPayload | SyncSingleRepositoryPayload;

export interface RepositorySyncJobResult {
  success: boolean;
  jobName: string;
  processedAt: string;
  details?: Record<string, any>;
}

@Injectable()
export class RepositorySyncWorker extends BaseWorker<RepositorySyncJobPayload, RepositorySyncJobResult> implements OnModuleInit {
  protected readonly queueName = QueueName.REPOSITORY_SYNC;

  constructor(redisService: RedisService) {
    super(redisService, RepositorySyncWorker.name, {
      concurrency: 5,
      limiter: {
        max: 30,
        duration: 60000, // 30 jobs per minute GitHub rate-limit safety
      },
    });
  }

  onModuleInit() {
    this.startWorker();
  }

  async processJob(job: Job<RepositorySyncJobPayload, RepositorySyncJobResult>): Promise<RepositorySyncJobResult> {
    const jobName = job.name;

    return CorrelationContext.run({ service: 'worker', jobId: job.id }, async () => {
      this.logger.info(`Starting repository sync job "${jobName}" [${job.id}]`, {
        jobId: job.id,
        jobName,
        payload: job.data,
      });

      return {
        success: true,
        jobName,
        processedAt: new Date().toISOString(),
        details: {
          jobId: job.id,
        },
      };
    });
  }
}
