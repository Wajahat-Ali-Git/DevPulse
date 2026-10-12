import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Logger } from '@devpulse/logger';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger({ service: 'worker', context: SchedulerService.name });
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
