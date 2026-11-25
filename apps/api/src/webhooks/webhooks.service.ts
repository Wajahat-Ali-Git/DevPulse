import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { config } from '@devpulse/config';
import { GitHubWebhooks } from '@devpulse/github';
import { Logger } from '@devpulse/logger';
import { DatabaseService } from '../database.service';
import { WebhooksQueueService } from './webhooks-queue.service';
import {
  isSupportedGitHubEvent,
  validateEventPayload,
  ValidatedWebhookEvent,
  WebhookMetadata,
} from './event-validator';

export interface ProcessGitHubWebhookOptions {
  rawBody: Buffer | string;
  parsedBody?: any;
  signature: string;
  event: string;
  deliveryId: string;
}

export interface WebhookResponse {
  received: boolean;
  event: string;
  delivery: string;
  status: 'accepted' | 'ignored';
  isDuplicate?: boolean;
  deliveryRecordId?: string;
  metadata?: WebhookMetadata;
  details?: Record<string, any>;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger({ service: 'api', context: 'WebhooksService' });

  constructor(
    private readonly database?: DatabaseService,
    private readonly queueService?: WebhooksQueueService,
  ) {}

  /**
   * Validates webhook signature using timingSafeEqual HMAC verification,
   * checks event type support, parses & validates payload fields,
   * verifies repository and actor ownership against connected accounts,
   * and dispatches/persists the event.
   */
  async processGitHubWebhook(options: ProcessGitHubWebhookOptions): Promise<WebhookResponse> {
    const { rawBody, signature, event, deliveryId } = options;

    // 1. Signature Verification
    const webhookSecret = config.github.webhookSecret;
    if (!webhookSecret) {
      this.logger.error('GitHub webhook secret is not configured in environment');
      throw new UnauthorizedException('Webhook verification failed');
    }

    const isValid = GitHubWebhooks.verifySignature({
      payload: rawBody,
      signature,
      secret: webhookSecret,
    });

    if (!isValid) {
      this.logger.warn('GitHub webhook signature mismatch', {
        event,
        deliveryId,
      });
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // 2. Check for duplicate delivery in database
    if (this.database?.client?.webhookDelivery) {
      try {
        const existingDelivery = await this.database.client.webhookDelivery.findUnique({
          where: { deliveryId },
          select: {
            id: true,
            status: true,
            eventType: true,
            createdAt: true,
          },
        });

        if (existingDelivery) {
          this.logger.info(`Detected duplicate delivery for deliveryId "${deliveryId}" (status: ${existingDelivery.status})`, {
            deliveryId,
            status: existingDelivery.status,
            event,
          });

          return {
            received: true,
            event: existingDelivery.eventType || event,
            delivery: deliveryId,
            status: 'accepted',
            isDuplicate: true,
            deliveryRecordId: existingDelivery.id,
            details: {
              duplicate: true,
              existingStatus: existingDelivery.status,
              firstReceivedAt: existingDelivery.createdAt,
            },
          };
        }
      } catch (err) {
        this.logger.warn(`Error checking existing webhook delivery [${deliveryId}]: ${(err as Error).message}`);
      }
    }

    // 3. Check if event is supported
    if (!isSupportedGitHubEvent(event)) {
      this.logger.info(`Safely ignored unsupported GitHub webhook event: [${event}] (delivery: ${deliveryId})`, {
        event,
        deliveryId,
      });
      return {
        received: true,
        event,
        delivery: deliveryId,
        status: 'ignored',
        details: { reason: 'unsupported_event' },
      };
    }

    // 3. Parse and validate JSON payload
    let parsedJson = options.parsedBody;
    if (!parsedJson) {
      try {
        const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        parsedJson = JSON.parse(text);
      } catch {
        throw new BadRequestException('Webhook payload must be a valid JSON object');
      }
    }

    const validatedEvent: ValidatedWebhookEvent = validateEventPayload(event, parsedJson, deliveryId);

    // 4. Handle GitHub Ping event separately
    if (validatedEvent.isPing) {
      this.logger.info(`Processed GitHub ping event (zen: "${parsedJson.zen || 'none'}") (delivery: ${deliveryId})`, {
        deliveryId,
      });

      let pingRecordId: string | undefined;
      if (this.database?.client?.webhookDelivery) {
        try {
          const record = await this.database.client.webhookDelivery.upsert({
            where: { deliveryId },
            update: {
              status: 'COMPLETED',
              payload: parsedJson,
              updatedAt: new Date(),
            },
            create: {
              deliveryId,
              eventType: 'ping',
              action: parsedJson.action,
              payload: parsedJson,
              status: 'COMPLETED',
              receivedAt: validatedEvent.metadata.receivedAt,
              processedAt: new Date(),
            },
          });
          pingRecordId = record.id;
        } catch (err) {
          this.logger.warn(`Failed to persist ping webhook delivery: ${(err as Error).message}`, {
            deliveryId,
          });
        }
      }

      return {
        received: true,
        event: 'ping',
        delivery: deliveryId,
        status: 'accepted',
        deliveryRecordId: pingRecordId,
        metadata: validatedEvent.metadata,
        details: { zen: parsedJson.zen, hookId: parsedJson.hook_id },
      };
    }

    // 5. Validate repository against connected accounts / tracked repositories
    const { repository, actor } = validatedEvent;
    let connectedAccountId: string | undefined;
    let trackedRepoId: string | undefined;

    if (this.database?.client && repository) {
      // Find if this repository is tracked in DevPulse
      const existingRepo = await this.database.client.repository.findFirst({
        where: { githubId: repository.githubRepoId },
        select: { id: true, workspaceId: true },
      });

      if (existingRepo) {
        trackedRepoId = existingRepo.id;
      }

      // Check if the actor or repository owner matches a connected GitHub account in DevPulse
      if (actor?.githubUserId) {
        const connectedAccount = await this.database.client.gitHubAccount.findFirst({
          where: { githubUserId: actor.githubUserId },
          select: { id: true, userId: true },
        });
        if (connectedAccount) {
          connectedAccountId = connectedAccount.id;
        }
      }
    }

    // 6. Persist accepted event metadata and payload to WebhookDelivery
    let deliveryRecordId: string | undefined;
    let isDuplicateDelivery = false;
    if (this.database?.client?.webhookDelivery) {
      try {
        const record = await this.database.client.webhookDelivery.upsert({
          where: { deliveryId },
          update: {
            // If another concurrent request inserted it first, update updatedAt without duplicating
            updatedAt: new Date(),
          },
          create: {
            deliveryId,
            eventType: event,
            action: validatedEvent.action,
            repositoryId: trackedRepoId,
            githubRepositoryId: repository?.githubRepoId,
            senderGithubId: actor?.githubUserId,
            payload: parsedJson,
            status: 'RECEIVED',
            receivedAt: validatedEvent.metadata.receivedAt,
          },
        });
        deliveryRecordId = record.id;
      } catch (err) {
        // Safe concurrent duplicate handling: P2002 Unique constraint violation
        if ((err as any)?.code === 'P2002') {
          isDuplicateDelivery = true;
          this.logger.info(`Concurrent duplicate delivery caught by unique constraint for [${deliveryId}]`, {
            deliveryId,
          });
          const existing = await this.database.client.webhookDelivery.findUnique({
            where: { deliveryId },
            select: { id: true },
          });
          deliveryRecordId = existing?.id;
        } else {
          this.logger.warn(`Failed to persist webhook delivery [${deliveryId}]: ${(err as Error).message}`, {
            deliveryId,
            event,
          });
        }
      }
    }

    // 7. Enqueue webhook event to BullMQ if queue service is available
    // Do NOT enqueue if this delivery was already processed or detected as duplicate
    let enqueued = false;
    if (this.queueService && !isDuplicateDelivery) {
      try {
        const result = await this.queueService.addWebhookEventJob({
          deliveryId,
          event,
          action: validatedEvent.action,
          repositoryId: trackedRepoId,
          githubRepoId: repository ? Number(repository.githubRepoId) : undefined,
          sender: actor?.username,
          rawPayload: parsedJson,
          receivedAt: validatedEvent.metadata.receivedAt.toISOString(),
        });
        enqueued = result.enqueued;
      } catch (queueErr) {
        this.logger.warn(`Failed to enqueue webhook job for [${deliveryId}]: ${(queueErr as Error).message}`);
      }
    }

    this.logger.info(`Received verified GitHub event: [${event}] for repo "${repository?.fullName}" (delivery: ${deliveryId})`, {
      event,
      deliveryId,
      deliveryRecordId,
      enqueued,
      repo: repository?.fullName,
      trackedRepoId,
      connectedAccountId,
    });

    return {
      received: true,
      event,
      delivery: deliveryId,
      status: 'accepted',
      isDuplicate: isDuplicateDelivery,
      deliveryRecordId,
      metadata: validatedEvent.metadata,
      details: {
        repository: repository?.fullName,
        action: validatedEvent.action,
        enqueued,
        isTracked: Boolean(trackedRepoId),
        hasConnectedAccount: Boolean(connectedAccountId),
      },
    };
  }
}
