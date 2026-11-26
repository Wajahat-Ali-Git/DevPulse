import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, ConnectionOptions } from 'bullmq';
import { QueueName, JobName, WebhookEventPayload } from '@devpulse/types';
import { Logger } from '@devpulse/logger';
import { RedisService } from '../redis.service';
import { DatabaseService } from '../database.service';

export interface WebhookEnqueueOptions {
  jobId: string;
  delay?: number;
  priority?: number;
}

export interface RecoverUnqueuedDeliveriesOptions {
  batchSize?: number;
  maxAgeMinutes?: number;
}

/**
 * Dedicated BullMQ queue service for GitHub webhook events.
 *
 * Configures the `github-webhooks` BullMQ Queue with:
 * - Shared Redis connection from RedisService
 * - Default retry policy: 5 attempts with exponential backoff (starting at 1000ms)
 * - Strict job deduplication using deliveryId as stable jobId
 * - Automated completed/failed job cleanup retention
 * - Failure handling preserving database records
 * - Automated recovery mechanism for persisted but unqueued deliveries
 * - Graceful lifecycle teardown on module destruction
 */
@Injectable()
export class WebhooksQueueService implements OnModuleDestroy {
  private readonly logger = new Logger({ service: 'api', context: WebhooksQueueService.name });
  private queue?: Queue;

  constructor(
    private readonly redisService?: RedisService,
    private readonly database?: DatabaseService,
  ) {}

  public getQueue(): Queue {
    if (!this.queue) {
      const connection: ConnectionOptions = this.redisService?.client as any;
      this.queue = new Queue(QueueName.GITHUB_WEBHOOKS, {
        connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 1000, // 1s, 2s, 4s, 8s, 16s
          },
          removeOnComplete: {
            count: 2000,
            age: 24 * 3600, // 24 hours
          },
          removeOnFail: {
            count: 5000,
            age: 7 * 24 * 3600, // 7 days
          },
        },
      });

      this.logger.info(`Dedicated BullMQ queue initialized: [${QueueName.GITHUB_WEBHOOKS}]`);
    }
    return this.queue;
  }

  /**
   * Enqueues a webhook event to BullMQ using deliveryId as stable jobId.
   * Handles queue failures safely without losing the persisted delivery.
   */
  async addWebhookEventJob(
    payload: WebhookEventPayload,
    options?: Partial<WebhookEnqueueOptions>,
  ): Promise<{ enqueued: boolean; jobId: string }> {
    const queue = this.getQueue();
    // Stable identifier: use deliveryId as jobId
    const jobId = options?.jobId || payload.deliveryId;

    try {
      const job = await queue.add(JobName.PROCESS_WEBHOOK_EVENT, payload, {
        jobId,
        priority: options?.priority,
        delay: options?.delay,
      });

      this.logger.info(`Enqueued webhook event job [${job.id}] for delivery "${payload.deliveryId}" (event: ${payload.event || payload.eventType})`, {
        jobId: job.id,
        deliveryId: payload.deliveryId,
        deliveryDatabaseId: payload.deliveryDatabaseId,
        event: payload.event || payload.eventType,
      });

      return { enqueued: true, jobId: job.id! };
    } catch (err) {
      // If queue failure occurs (e.g. Redis disconnect or job already exists),
      // the delivery record in PostgreSQL remains safely intact.
      this.logger.warn(`Webhook job already exists or queue dispatch failed for delivery [${payload.deliveryId}]: ${(err as Error).message}`);
      return { enqueued: false, jobId };
    }
  }

  /**
   * Recovery mechanism: scans for persisted deliveries in status 'RECEIVED'
   * that have not been processed or queued, and re-enqueues them to BullMQ.
   */
  async recoverUnqueuedDeliveries(options?: RecoverUnqueuedDeliveriesOptions): Promise<{ recoveredCount: number; errors: number }> {
    if (!this.database?.client?.webhookDelivery) {
      return { recoveredCount: 0, errors: 0 };
    }

    const batchSize = options?.batchSize || 50;
    const maxAgeMinutes = options?.maxAgeMinutes || 5;
    const thresholdDate = new Date(Date.now() - maxAgeMinutes * 60 * 1000);

    let recoveredCount = 0;
    let errors = 0;

    try {
      // Find unqueued/pending deliveries created before thresholdDate or recently received
      const unqueued = await this.database.client.webhookDelivery.findMany({
        where: {
          status: 'RECEIVED',
          processedAt: null,
          receivedAt: {
            lte: thresholdDate,
          },
        },
        take: batchSize,
        orderBy: { receivedAt: 'asc' },
      });

      if (unqueued.length === 0) {
        return { recoveredCount: 0, errors: 0 };
      }

      this.logger.info(`Starting recovery sweep for ${unqueued.length} unqueued webhook deliverie(s)`);

      for (const delivery of unqueued) {
        try {
          const res = await this.addWebhookEventJob({
            deliveryDatabaseId: delivery.id,
            deliveryId: delivery.deliveryId,
            event: delivery.eventType,
            eventType: delivery.eventType,
            action: delivery.action || undefined,
            repositoryId: delivery.repositoryId || undefined,
            githubRepoId: delivery.githubRepositoryId ? Number(delivery.githubRepositoryId) : undefined,
            rawPayload: delivery.payload as any,
            receivedAt: delivery.receivedAt.toISOString(),
          });

          if (res.enqueued) {
            recoveredCount++;
          }
        } catch (enqueueErr) {
          errors++;
          this.logger.error(`Failed to recover unqueued delivery [${delivery.deliveryId}]: ${(enqueueErr as Error).message}`);
        }
      }

      this.logger.info(`Recovery sweep finished: ${recoveredCount} enqueued, ${errors} errors`);
    } catch (err) {
      this.logger.error(`Error querying unqueued webhook deliveries for recovery: ${(err as Error).message}`);
    }

    return { recoveredCount, errors };
  }

  async onModuleDestroy() {
    if (this.queue) {
      this.logger.info(`Gracefully closing BullMQ queue: [${QueueName.GITHUB_WEBHOOKS}]`);
      await this.queue.close();
      this.queue = undefined;
    }
  }
}
