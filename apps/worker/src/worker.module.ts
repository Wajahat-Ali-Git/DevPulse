import { Module } from '@nestjs/common';
import { RedisService } from './redis/redis.service';
import { QueueService } from './queues/queue.service';
import { SampleProcessor } from './processors/sample.processor';
import { SchedulerService } from './scheduler/scheduler.service';

@Module({
  imports: [],
  providers: [
    RedisService,
    QueueService,
    SampleProcessor,
    SchedulerService,
  ],
  exports: [
    RedisService,
    QueueService,
    SampleProcessor,
    SchedulerService,
  ],
})
export class WorkerModule {}

