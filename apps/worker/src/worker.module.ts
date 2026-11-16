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
import { GitHubSyncProcessor } from './processors/github-sync.processor';
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
    GitHubSyncProcessor,
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
    GitHubSyncProcessor,
    SchedulerService,
  ],
})
export class WorkerModule {}
