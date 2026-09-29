import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private timer?: NodeJS.Timeout;

  onModuleInit() {
    this.logger.log('Initializing worker scheduler...');
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.logger.log('Worker scheduler stopped.');
  }
}
