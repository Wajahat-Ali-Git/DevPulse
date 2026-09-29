import { Injectable, Logger } from '@nestjs/common';
import { JobData } from '../jobs/job.interface';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  async addJob<T>(queueName: string, name: string, payload: T): Promise<JobData<T>> {
    const job: JobData<T> = {
      id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      name,
      payload,
      createdAt: new Date(),
    };

    this.logger.log(`Job [${job.id}] added to queue [${queueName}]`);
    return job;
  }
}
