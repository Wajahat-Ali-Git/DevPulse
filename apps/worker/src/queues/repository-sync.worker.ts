import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  QueueName,
  JobName,
  SyncUserRepositoriesPayload,
  SyncSingleRepositoryPayload,
  SyncRepositoryCommitsPayload,
  SyncRepositoryPullRequestsPayload,
  RepositorySyncJobPayload as DedicatedSyncPayload,
} from '@devpulse/types';
import { CorrelationContext } from '@devpulse/logger';
import { RedisService } from '../redis/redis.service';
import { BaseWorker } from './base.worker';
import { GitHubSyncProcessor } from '../processors/github-sync.processor';

export type RepositorySyncJobPayload =
  | SyncUserRepositoriesPayload
  | SyncSingleRepositoryPayload
  | SyncRepositoryCommitsPayload
  | SyncRepositoryPullRequestsPayload
  | DedicatedSyncPayload;

export interface RepositorySyncJobResult {
  success: boolean;
  jobName: string;
  processedAt: string;
  details?: Record<string, any>;
  data?: any;
}

@Injectable()
export class RepositorySyncWorker extends BaseWorker<RepositorySyncJobPayload, RepositorySyncJobResult> implements OnModuleInit {
  protected readonly queueName = QueueName.REPOSITORY_SYNC;

  constructor(
    redisService: RedisService,
    @Optional() private readonly gitHubSyncProcessor?: GitHubSyncProcessor,
  ) {
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
    const processor = this.gitHubSyncProcessor || new GitHubSyncProcessor();

    return CorrelationContext.run({ service: 'worker', jobId: job.id }, async () => {
      this.logger.info(`Starting repository sync job "${jobName}" [${job.id}]`, {
        jobId: job.id,
        jobName,
        payload: job.data,
      });

      let syncData: any = undefined;

      switch (jobName) {
        case JobName.SYNC_USER_REPOSITORIES: {
          syncData = await processor.syncUserRepositories(
            job.data as SyncUserRepositoriesPayload,
            {},
            undefined,
            async (progressUpdate) => {
              if (typeof job.updateProgress === 'function') {
                await job.updateProgress(progressUpdate.percentage ?? progressUpdate.totalProcessed);
              }
            },
          );
          break;
        }
        case JobName.SYNC_SINGLE_REPOSITORY: {
          syncData = await processor.syncSingleRepository(job.data as SyncSingleRepositoryPayload);
          if (typeof job.updateProgress === 'function') {
            await job.updateProgress(100);
          }
          break;
        }
        case JobName.SYNC_REPOSITORY_COMMITS: {
          syncData = await processor.syncRepositoryCommits(job.data as SyncRepositoryCommitsPayload);
          if (typeof job.updateProgress === 'function') {
            await job.updateProgress(100);
          }
          break;
        }
        case JobName.SYNC_REPOSITORY_PULL_REQUESTS: {
          syncData = await processor.syncRepositoryPullRequests(job.data as SyncRepositoryPullRequestsPayload);
          if (typeof job.updateProgress === 'function') {
            await job.updateProgress(100);
          }
          break;
        }
        default: {
          this.logger.warn(`Unknown sync job name: "${jobName}", using default user repositories sync handler`);
          syncData = await processor.syncUserRepositories(
            job.data as SyncUserRepositoriesPayload,
            {},
            undefined,
            async (progressUpdate) => {
              if (typeof job.updateProgress === 'function') {
                await job.updateProgress(progressUpdate.percentage ?? progressUpdate.totalProcessed);
              }
            },
          );
        }
      }

      return {
        success: true,
        jobName,
        processedAt: new Date().toISOString(),
        details: {
          jobId: job.id,
          syncId: (job.data as any)?.syncId,
          userId: (job.data as any)?.userId,
          scope: (job.data as any)?.scope,
          totalCount: syncData?.totalCount,
        },
        data: syncData,
      };
    });
  }
}
