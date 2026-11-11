import { Injectable, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueName, JobName, WebhookEventPayload } from '@devpulse/types';
import { CorrelationContext } from '@devpulse/logger';
import { RedisService } from '../redis/redis.service';
import { BaseWorker } from './base.worker';

export interface WebhookJobResult {
  received: boolean;
  deliveryId: string;
  eventType: string;
  processedAt: string;
}

@Injectable()
export class WebhookWorker extends BaseWorker<WebhookEventPayload, WebhookJobResult> implements OnModuleInit {
  protected readonly queueName = QueueName.GITHUB_WEBHOOKS;

  constructor(redisService: RedisService) {
    super(redisService, WebhookWorker.name, { concurrency: 10 });
  }

  onModuleInit() {
    this.startWorker();
  }

  async processJob(job: Job<WebhookEventPayload, WebhookJobResult>): Promise<WebhookJobResult> {
    const { deliveryId, event, action, sender } = job.data;

    return CorrelationContext.run({ service: 'worker', jobId: job.id, correlationId: deliveryId }, async () => {
      this.logger.info(`Processing GitHub webhook event "${event}" (action: ${action ?? 'none'}, delivery: ${deliveryId})`, {
        jobId: job.id,
        deliveryId,
        event,
        action,
        sender,
      });

      return {
        received: true,
        deliveryId,
        eventType: event,
        processedAt: new Date().toISOString(),
      };
    });
  }
}
