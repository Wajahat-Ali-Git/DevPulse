import { Module } from '@nestjs/common';
import { RedisService } from './redis/redis.service';
import {
  QueueService,
  WebhookWorker,
  RepositorySyncWorker,
  MetricsWorker,
  SampleWorker,
} from './queues';
import { SampleProcessor } from './processors/sample.processor';
import { SchedulerService } from './scheduler/scheduler.service';

@Module({
  imports: [],
  providers: [
    RedisService,
    QueueService,
    WebhookWorker,
    RepositorySyncWorker,
    MetricsWorker,
    SampleWorker,
    SampleProcessor,
    SchedulerService,
  ],
  exports: [
    RedisService,
    QueueService,
    WebhookWorker,
    RepositorySyncWorker,
    MetricsWorker,
    SampleWorker,
    SampleProcessor,
    SchedulerService,
  ],
})
export class WorkerModule {}
