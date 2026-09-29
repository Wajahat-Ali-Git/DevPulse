import { Module } from '@nestjs/common';
import { QueueService } from './queues/queue.service';
import { SampleProcessor } from './processors/sample.processor';
import { SchedulerService } from './scheduler/scheduler.service';

@Module({
  imports: [],
  providers: [
    QueueService,
    SampleProcessor,
    SchedulerService,
  ],
  exports: [
    QueueService,
    SampleProcessor,
    SchedulerService,
  ],
})
export class WorkerModule {}
