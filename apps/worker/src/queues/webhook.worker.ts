import { Injectable, OnModuleInit } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { QueueName, WebhookEventPayload } from '@devpulse/types';
import { CorrelationContext } from '@devpulse/logger';
import { prisma, ActivityEventType } from '@devpulse/database';
import { RedisService } from '../redis/redis.service';
import { BaseWorker, FailedJobDetails } from './base.worker';
import { WebhookEventHandlers, WebhookEventHandlingResult } from '../processors/webhook-event.handlers';
import { isRetryableError } from './job-errors';

export interface WebhookJobResult {
  received: boolean;
  deliveryId: string;
  eventType: string;
  activityEventId?: string;
  isDuplicate?: boolean;
  handlingResult?: WebhookEventHandlingResult;
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
    // Non-blocking background sweep to recover stuck deliveries on worker restart
    this.recoverStuckProcessingDeliveries().catch(err => {
      this.logger.warn(`Initial stuck processing deliveries recovery sweep failed: ${err.message}`);
    });
  }

  /**
   * Recovers deliveries that were left permanently stuck in PROCESSING
   * due to sudden worker crashes, out-of-memory kills, or ungraceful host restarts.
   */
  async recoverStuckProcessingDeliveries(maxAgeMinutes: number = 15): Promise<number> {
    if (!prisma || !prisma.webhookDelivery) return 0;

    const thresholdDate = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    try {
      const stuck = await prisma.webhookDelivery.findMany({
        where: {
          status: 'PROCESSING',
          processedAt: null,
          updatedAt: { lte: thresholdDate },
        },
        select: { id: true, deliveryId: true, attemptCount: true },
        take: 50,
      });

      if (stuck.length === 0) return 0;

      this.logger.warn(`Found ${stuck.length} delivery(ies) stuck in PROCESSING beyond ${maxAgeMinutes}m threshold. Recovering...`);

      let recovered = 0;
      for (const item of stuck) {
        // If max attempts (5) reached, mark as FAILED so it can be audited/reprocessed safely.
        // Otherwise, reset back to QUEUED for automatic pickup.
        const shouldFail = item.attemptCount >= 5;
        await prisma.webhookDelivery.update({
          where: { id: item.id },
          data: {
            status: shouldFail ? 'FAILED' : 'QUEUED',
            errorMessage: shouldFail
              ? 'Processing timed out / worker crash after max attempts'
              : 'Recovered from crashed/stuck worker execution',
          },
        });
        recovered++;
      }

      this.logger.info(`Successfully recovered ${recovered} stuck delivery(ies)`);
      return recovered;
    } catch (err) {
      this.logger.error(`Failed to execute stuck delivery recovery: ${(err as Error).message}`);
      return 0;
    }
  }

  async processJob(job: Job<WebhookEventPayload, WebhookJobResult>): Promise<WebhookJobResult> {
    const { deliveryId, event, action, sender, repositoryId, rawPayload } = job.data;
    const attemptCount = (job.attemptsMade || 0) + 1;

        return CorrelationContext.run({ service: 'worker', jobId: String(job.id), correlationId: deliveryId }, async () => {
          this.logger.info(`Processing GitHub webhook event "${event}" (action: ${action ?? 'none'}, delivery: ${deliveryId}, attempt: ${attemptCount})`, {
            jobId: job.id,
            deliveryId,
            event,
            action,
            sender,
            attemptCount,
          });

          // 1. Transition WebhookDelivery status to PROCESSING and increment attempt count
          if (prisma && prisma.webhookDelivery) {
            try {
              await prisma.webhookDelivery.updateMany({
                where: { deliveryId },
                data: {
                  status: 'PROCESSING',
                  attemptCount,
                },
              });
            } catch (dbErr) {
              this.logger.warn(`Failed to update delivery [${deliveryId}] to PROCESSING: ${(dbErr as Error).message}`);
            }
          }

          // 2. Dispatch to dedicated event handlers by event type
          let handlingResult: WebhookEventHandlingResult | undefined;
              try {
                switch (event) {
                  case 'push':
                    handlingResult = await WebhookEventHandlers.handlePushEvent(job.data);
                    break;
                  case 'pull_request':
                    handlingResult = await WebhookEventHandlers.handlePullRequestEvent(job.data);
                    break;
                  case 'pull_request_review':
                    handlingResult = await WebhookEventHandlers.handlePullRequestReviewEvent(job.data);
                    break;
                  case 'repository':
                    handlingResult = await WebhookEventHandlers.handleRepositoryEvent(job.data);
                    break;
                  default:
                    this.logger.info(`No domain handler required for event type: ${event}`);
                    break;
                }
              } catch (handlerErr: any) {
                // If error is permanent (non-retryable), wrap in UnrecoverableError to avoid infinite retries
                const retryable = isRetryableError(handlerErr);
                if (!retryable) {
                  this.logger.error(`Permanent failure in handler for delivery [${deliveryId}]: ${handlerErr.message}`);
                  throw new UnrecoverableError(`Permanent handler error: ${handlerErr.message}`);
                }
                throw handlerErr;
              }

              let activityEventId: string | undefined;
              let isDuplicate = false;

              // 3. Map GitHub event name to ActivityEventType enum
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

              // 4. Deduplicate activity persistence using unique constraint on github_delivery
              if (prisma && prisma.activityEvent) {
                try {
                  const activity = await prisma.activityEvent.upsert({
                    where: { githubDelivery: deliveryId },
                    update: {
                      action,
                      actorUsername: sender || 'unknown',
                    },
                    create: {
                      githubDelivery: deliveryId,
                      repositoryId: repositoryId || handlingResult?.repositoryId || null,
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

              // 5. Update WebhookDelivery status to COMPLETED
              if (prisma && prisma.webhookDelivery) {
                try {
                  await prisma.webhookDelivery.updateMany({
                    where: { deliveryId },
                    data: {
                      status: 'COMPLETED',
                      processedAt: new Date(),
                      errorMessage: null,
                    },
                  });
                } catch {
                  // Non-blocking in offline DB or test mocks
                }
              }

              return {
                received: true,
                deliveryId,
                eventType: event,
                activityEventId,
                isDuplicate,
                handlingResult,
                processedAt: new Date().toISOString(),
              };
          });
      }

  /**
   * Handle failed webhook jobs: record error details and transition to FAILED
   * when attempts are exhausted or when the error is permanent.
   */
  protected override async handleFailedJob(details: FailedJobDetails): Promise < void> {
        await super.handleFailedJob(details);

        const deliveryId = details.correlationId || details.payload?.deliveryId;
        if(!deliveryId) return;

        const isExhausted = details.attemptsMade >= details.maxAttempts;
        const shouldMarkFailed = details.isPermanent || isExhausted;

        if(prisma && prisma.webhookDelivery) {
        try {
          await prisma.webhookDelivery.updateMany({
            where: { deliveryId },
            data: {
              attemptCount: details.attemptsMade,
              errorMessage: details.errorMessage,
              ...(shouldMarkFailed ? { status: 'FAILED' } : {}),
            },
          });

          this.logger.warn(
            `Updated delivery [${deliveryId}] failure telemetry (attempt: ${details.attemptsMade}/${details.maxAttempts}, finalStatus: ${shouldMarkFailed ? 'FAILED' : 'RETRYING'}): ${details.errorMessage}`,
            {
              deliveryId,
              jobId: details.jobId,
              attemptsMade: details.attemptsMade,
              maxAttempts: details.maxAttempts,
              isPermanent: details.isPermanent,
              isExhausted,
            },
          );
        } catch (dbErr) {
          this.logger.error(`Failed to record error state for delivery [${deliveryId}]: ${(dbErr as Error).message}`);
        }
      }
    }
}


