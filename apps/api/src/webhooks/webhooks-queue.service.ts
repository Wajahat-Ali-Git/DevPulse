import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, ConnectionOptions } from 'bullmq';
import { QueueName, JobName, WebhookEventPayload } from '@devpulse/types';
import { Logger } from '@devpulse/logger';
import { RedisService } from '../redis.service';

export interface WebhookEnqueueOptions {
  jobId: string;
  delay?: number;
  priority?: number;
}

/**
 * Dedicated BullMQ queue service for GitHub webhook events.
 *
 * Configures the `github-webhooks` BullMQ Queue with:
 * - Shared Redis connection from RedisService
 * - Default retry and exponential backoff policies
 * - Strict job deduplication using deliveryId as jobId
 * - Automated completed/failed job cleanup retention
 * - Graceful lifecycle teardown on module destruction
 */
@Injectable()
export class WebhooksQueueService implements OnModuleDestroy {
  private readonly logger = new Logger({ service: 'api', context: WebhooksQueueService.name });
  private queue?: Queue;

  constructor(private readonly redisService?: RedisService) {}

  public getQueue(): Queue {
    if (!this.queue) {
      const connection: ConnectionOptions = this.redisService?.client as any;
      this.queue = new Queue(QueueName.GITHUB_WEBHOOKS, {
        connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
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
   * Enqueues a webhook event to BullMQ using deliveryId as the jobId to guarantee
   * queue-level deduplication and prevent concurrent or duplicate jobs.
   */
  async addWebhookEventJob(
    payload: WebhookEventPayload,
    options?: Partial<WebhookEnqueueOptions>,
  ): Promise<{ enqueued: boolean; jobId: string }> {
    const queue = this.getQueue();
    const jobId = options?.jobId || payload.deliveryId;

    try {
      const job = await queue.add(JobName.PROCESS_WEBHOOK_EVENT, payload, {
        jobId,
        priority: options?.priority,
        delay: options?.delay,
      });

      this.logger.info(`Enqueued webhook event job [${job.id}] for delivery "${payload.deliveryId}" (event: ${payload.event})`, {
        jobId: job.id,
        deliveryId: payload.deliveryId,
        event: payload.event,
      });

      return { enqueued: true, jobId: job.id! };
    } catch (err) {
      // BullMQ safely ignores or throws on duplicate jobId depending on options
      this.logger.warn(`Webhook job already exists or could not be re-enqueued for delivery [${payload.deliveryId}]: ${(err as Error).message}`);
      return { enqueued: false, jobId };
    }
  }

  async onModuleDestroy() {
    if (this.queue) {
      this.logger.info(`Gracefully closing BullMQ queue: [${QueueName.GITHUB_WEBHOOKS}]`);
      await this.queue.close();
      this.queue = undefined;
    }
  }
}
