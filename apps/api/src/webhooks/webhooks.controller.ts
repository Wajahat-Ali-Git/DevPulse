import {
  Controller,
  Post,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { WebhooksService } from './webhooks.service';
import { Logger } from '@devpulse/logger';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger({ service: 'api', context: 'WebhooksController' });

  constructor(private readonly webhooksService: WebhooksService) {}

  @Public()
  @Post('github')
  @HttpCode(HttpStatus.ACCEPTED)
  async handleGitHubWebhook(
    @Req() req: Request,
    @Headers('x-hub-signature-256') signature?: string,
    @Headers('x-github-event') event?: string,
    @Headers('x-github-delivery') deliveryId?: string,
    @Headers('content-type') contentType?: string,
  ) {
    // 1. Content-Type Validation
    // GitHub webhooks send application/json (or application/x-www-form-urlencoded).
    // DevPulse strictly expects application/json.
    if (!contentType || !contentType.toLowerCase().includes('application/json')) {
      this.logger.warn('GitHub webhook rejected: invalid or unsupported Content-Type', {
        contentType,
        deliveryId,
      });
      throw new BadRequestException('Unsupported or missing Content-Type. Expected application/json');
    }

    // 2. Required GitHub Headers Validation
    if (!event || event.trim() === '') {
      this.logger.warn('GitHub webhook rejected: missing X-GitHub-Event header', { deliveryId });
      throw new BadRequestException('Missing required header: X-GitHub-Event');
    }

    if (!deliveryId || deliveryId.trim() === '') {
      this.logger.warn('GitHub webhook rejected: missing X-GitHub-Delivery header', { event });
      throw new BadRequestException('Missing required header: X-GitHub-Delivery');
    }

    if (!signature || signature.trim() === '') {
      this.logger.warn('GitHub webhook rejected: missing X-Hub-Signature-256 header', {
        event,
        deliveryId,
      });
      throw new UnauthorizedException('Missing webhook signature');
    }

    // 3. Raw Body Acquisition
    // rawBody is attached by express raw body parser or buffer
    const rawBody: Buffer | string | undefined = (req as any).rawBody;
    const bodyToVerify: Buffer | string =
      rawBody !== undefined
        ? rawBody
        : typeof req.body === 'string'
        ? req.body
        : Buffer.isBuffer(req.body)
        ? req.body
        : JSON.stringify(req.body || {});

    // 4. Verification and Ingestion
    return await this.webhooksService.processGitHubWebhook({
      rawBody: bodyToVerify,
      parsedBody: req.body,
      signature,
      event,
      deliveryId,
    });
  }
}
