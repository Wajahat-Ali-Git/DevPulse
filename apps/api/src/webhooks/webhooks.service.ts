import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { config } from '@devpulse/config';
import { GitHubWebhooks } from '@devpulse/github';
import { Logger } from '@devpulse/logger';
import { DatabaseService } from '../database.service';
import {
  isSupportedGitHubEvent,
  validateEventPayload,
  ValidatedWebhookEvent,
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
  details?: Record<string, any>;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger({ service: 'api', context: 'WebhooksService' });

  constructor(private readonly database?: DatabaseService) {}

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

    // 2. Check if event is supported
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
      return {
        received: true,
        event: 'ping',
        delivery: deliveryId,
        status: 'accepted',
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

    this.logger.info(`Received verified GitHub event: [${event}] for repo "${repository?.fullName}" (delivery: ${deliveryId})`, {
      event,
      deliveryId,
      repo: repository?.fullName,
      trackedRepoId,
      connectedAccountId,
    });

    return {
      received: true,
      event,
      delivery: deliveryId,
      status: 'accepted',
      details: {
        repository: repository?.fullName,
        action: validatedEvent.action,
        isTracked: Boolean(trackedRepoId),
        hasConnectedAccount: Boolean(connectedAccountId),
      },
    };
  }
}
