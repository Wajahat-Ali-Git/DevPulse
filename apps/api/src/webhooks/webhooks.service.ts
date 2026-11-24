import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { config } from '@devpulse/config';
import { GitHubWebhooks } from '@devpulse/github';
import { Logger } from '@devpulse/logger';

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
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger({ service: 'api', context: 'WebhooksService' });

  /**
   * Validates webhook signature using constant-time timingSafeEqual HMAC verification
   * and dispatches/enqueues the event.
   */
  async processGitHubWebhook(options: ProcessGitHubWebhookOptions): Promise<WebhookResponse> {
    const { rawBody, signature, event, deliveryId } = options;

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
      // Do not expose internal details, return standard unauthorized
      throw new UnauthorizedException('Invalid webhook signature');
    }

    this.logger.info(`Received verified GitHub webhook event: [${event}] (delivery: ${deliveryId})`, {
      event,
      deliveryId,
    });

    // Handle ping event or any registered event
    return {
      received: true,
      event,
      delivery: deliveryId,
    };
  }
}
