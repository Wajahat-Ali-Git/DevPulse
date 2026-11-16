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
import { CorrelationContext, redactCredentialString } from '@devpulse/logger';
import { prisma } from '@devpulse/database';
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
    const syncId = (job.data as any)?.syncId || String(job.id);
    const userId = (job.data as any)?.userId;

    return CorrelationContext.run({ service: 'worker', jobId: job.id }, async () => {
      this.logger.info(`Starting repository sync job "${jobName}" [${job.id}]`, {
        jobId: job.id,
        jobName,
        payload: job.data,
      });

      // Update SyncRun state to PROCESSING if record exists
      try {
        if (prisma && prisma.syncRun && typeof prisma.syncRun.updateMany === 'function') {
          await prisma.syncRun.updateMany({
            where: {
              OR: [{ id: syncId }, { jobId: String(job.id) }],
            },
            data: {
              status: 'PROCESSING',
              startedAt: new Date(),
              lastProcessedAt: new Date(),
            },
          });
        }
      } catch (err: any) {
        this.logger.debug(`Could not update SyncRun to PROCESSING: ${err?.message}`);
      }

      let syncData: any = undefined;

      try {
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
                // Update SyncRun with intermediate progress
                try {
                  if (prisma && prisma.syncRun && typeof prisma.syncRun.updateMany === 'function') {
                    await prisma.syncRun.updateMany({
                      where: {
                        OR: [{ id: syncId }, { jobId: String(job.id) }],
                      },
                      data: {
                        processedItems: progressUpdate.totalProcessed ?? 0,
                        lastProcessedAt: new Date(),
                      },
                    });
                  }
                } catch {
                  // progress tracking failure shouldn't abort job
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

        // Mark SyncRun as COMPLETED
        try {
          if (prisma && prisma.syncRun && typeof prisma.syncRun.updateMany === 'function') {
            await prisma.syncRun.updateMany({
              where: {
                OR: [{ id: syncId }, { jobId: String(job.id) }],
              },
              data: {
                status: 'COMPLETED',
                completedAt: new Date(),
                lastProcessedAt: new Date(),
                totalItems: syncData?.totalCount ?? 0,
                processedItems: syncData?.totalCount ?? 0,
              },
            });
          }
        } catch (err: any) {
          this.logger.debug(`Could not update SyncRun to COMPLETED: ${err?.message}`);
        }

        return {
          success: true,
          jobName,
          processedAt: new Date().toISOString(),
          details: {
            jobId: job.id,
            syncId,
            userId,
            scope: (job.data as any)?.scope,
            totalCount: syncData?.totalCount,
          },
          data: syncData,
        };
      } catch (error: any) {
        // Mark SyncRun as FAILED on error with sanitized error message
        try {
          if (prisma && prisma.syncRun && typeof prisma.syncRun.updateMany === 'function') {
            const rawErrorMsg = error?.message || 'Sync execution failed';
            const safeErrorMessage = redactCredentialString(rawErrorMsg);
            await prisma.syncRun.updateMany({
              where: {
                OR: [{ id: syncId }, { jobId: String(job.id) }],
              },
              data: {
                status: 'FAILED',
                errorMessage: safeErrorMessage,
                lastProcessedAt: new Date(),
              },
            });
          }
        } catch {
          // ignore
        }
        throw error;
      }
    });
  }
}
