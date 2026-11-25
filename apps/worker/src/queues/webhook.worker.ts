import { Injectable, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { QueueName, JobName, WebhookEventPayload } from '@devpulse/types';
import { CorrelationContext } from '@devpulse/logger';
import { prisma, ActivityEventType } from '@devpulse/database';
import { RedisService } from '../redis/redis.service';
import { BaseWorker } from './base.worker';

export interface WebhookJobResult {
  received: boolean;
  deliveryId: string;
  eventType: string;
  activityEventId?: string;
  isDuplicate?: boolean;
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
    const { deliveryId, event, action, sender, repositoryId, rawPayload } = job.data;

    return CorrelationContext.run({ service: 'worker', jobId: job.id, correlationId: deliveryId }, async () => {
      this.logger.info(`Processing GitHub webhook event "${event}" (action: ${action ?? 'none'}, delivery: ${deliveryId})`, {
        jobId: job.id,
        deliveryId,
        event,
        action,
        sender,
      });

      let activityEventId: string | undefined;
      let isDuplicate = false;

      // Map GitHub event name to ActivityEventType enum
      let activityEventType: ActivityEventType = ActivityEventType.OTHER;
      if (event === 'push') {
        activityEventType = ActivityEventType.PUSH;
      } else if (event === 'pull_request') {
        if (action === 'opened') activityEventType = ActivityEventType.PULL_REQUEST_OPENED;
        else if (action === 'closed' && rawPayload?.pull_request?.merged) activityEventType = ActivityEventType.PULL_REQUEST_MERGED;
        else if (action === 'closed') activityEventType = ActivityEventType.PULL_REQUEST_CLOSED;
        else if (action === 'reopened') activityEventType = ActivityEventType.PULL_REQUEST_REOPENED;
      } else if (event === 'pull_request_review') {
        activityEventType = ActivityEventType.PULL_REQUEST_REVIEW;
      }

      // Deduplicate activity persistence using unique constraint on github_delivery
      if (prisma && prisma.activityEvent) {
        try {
          const activity = await prisma.activityEvent.upsert({
            where: { githubDelivery: deliveryId },
            update: {
              // Idempotent: don't create duplicates on retries
              action,
              actorUsername: sender || 'unknown',
            },
            create: {
              githubDelivery: deliveryId,
              repositoryId: repositoryId || null,
              eventType: activityEventType,
              action: action || null,
              actorUsername: sender || 'unknown',
              payload: rawPayload || {},
              occurredAt: new Date(job.data.receivedAt || Date.now()),
            },
          });
          activityEventId = activity.id;
        } catch (dbErr: any) {
          if (dbErr?.code === 'P2002') {
            isDuplicate = true;
            this.logger.info(`Duplicate activity event record caught for delivery [${deliveryId}]`);
          } else {
            this.logger.warn(`Failed to upsert activity event for delivery [${deliveryId}]: ${dbErr.message}`);
          }
        }
      }

      // Update WebhookDelivery status to COMPLETED
      if (prisma && prisma.webhookDelivery) {
        try {
          await prisma.webhookDelivery.updateMany({
            where: { deliveryId },
            data: {
              status: 'COMPLETED',
              processedAt: new Date(),
            },
          });
        } catch {
          // Non-blocking in tests or offline DB
        }
      }

      return {
        received: true,
        deliveryId,
        eventType: event,
        activityEventId,
        isDuplicate,
        processedAt: new Date().toISOString(),
      };
    });
  }
}

