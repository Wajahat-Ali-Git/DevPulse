import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, ConnectionOptions } from 'bullmq';
import { QueueName, JobName, SyncUserRepositoriesPayload, SyncSingleRepositoryPayload } from '@devpulse/types';
import { Logger } from '@devpulse/logger';
import { RedisService } from '../redis.service';

export interface RepositorySyncEnqueueOptions {
  jobId?: string;
  correlationId?: string;
  delay?: number;
  priority?: number;
}

/**
 * Dedicated BullMQ queue service for repository synchronization.
 *
 * Configures the dedicated `repository-sync` BullMQ Queue with:
 * - Shared Redis connection from RedisService
 * - Default retry and exponential backoff policies suitable for GitHub API sync
 * - Automated completed/failed job cleanup retention
 * - Dedicated typed methods for repository synchronization jobs
 * - Graceful lifecycle teardown on module destruction
 */
@Injectable()
export class RepositorySyncQueueService implements OnModuleDestroy {
  private readonly logger = new Logger({ service: 'api', context: RepositorySyncQueueService.name });
  private queue?: Queue;

  constructor(private readonly redisService?: RedisService) {}

  /**
   * Returns or lazily creates the dedicated repository-sync BullMQ queue.
   */
  public getQueue(): Queue {
    if (!this.queue) {
      const connection: ConnectionOptions = this.redisService?.client as any;
      this.queue = new Queue(QueueName.REPOSITORY_SYNC, {
        connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000, // 2s, 4s, 8s, 16s, 32s backoff for external GitHub API sync
          },
          removeOnComplete: {
            count: 1000,
            age: 24 * 3600, // 24 hours
          },
          removeOnFail: {
            count: 5000,
            age: 7 * 24 * 3600, // 7 days
          },
        },
      });

      this.logger.info(`Dedicated BullMQ queue initialized: [${QueueName.REPOSITORY_SYNC}]`);
    }
    return this.queue;
  }

  /**
   * Enqueues a sync job for all repositories belonging to a user/workspace.
   */
  async addSyncUserRepositoriesJob(
    payload: SyncUserRepositoriesPayload & { correlationId?: string },
    options: RepositorySyncEnqueueOptions = {},
  ) {
    const queue = this.getQueue();
    const jobId = options.jobId || options.correlationId;
    return queue.add(JobName.SYNC_USER_REPOSITORIES, payload, {
      jobId,
      delay: options.delay,
      priority: options.priority,
    });
  }

  /**
   * Enqueues a sync job for a single repository.
   */
  async addSyncSingleRepositoryJob(
    payload: SyncSingleRepositoryPayload & { correlationId?: string },
    options: RepositorySyncEnqueueOptions = {},
  ) {
    const queue = this.getQueue();
    const jobId = options.jobId || options.correlationId;
    return queue.add(JobName.SYNC_SINGLE_REPOSITORY, payload, {
      jobId,
      delay: options.delay,
      priority: options.priority,
    });
  }

  /**
   * Retrieves a job by ID from the dedicated repository sync queue.
   */
  async getJob(jobId: string) {
    const queue = this.getQueue();
    return queue.getJob(jobId);
  }

  /**
   * Gracefully closes the dedicated repository synchronization queue on shutdown.
   */
  async onModuleDestroy() {
    if (this.queue) {
      this.logger.info(`Closing dedicated BullMQ queue [${QueueName.REPOSITORY_SYNC}]...`);
      await this.queue.close();
      this.logger.info(`Dedicated BullMQ queue [${QueueName.REPOSITORY_SYNC}] closed cleanly.`);
    }
  }
}

