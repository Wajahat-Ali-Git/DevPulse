import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhooksQueueService } from './webhooks-queue.service';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhooksQueueService, DatabaseService, RedisService],
  exports: [WebhooksService, WebhooksQueueService],
})
export class WebhooksModule {}
