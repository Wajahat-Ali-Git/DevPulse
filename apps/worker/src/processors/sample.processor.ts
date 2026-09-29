import { Injectable, Logger } from '@nestjs/common';
import { JobData, JobResult } from '../jobs/job.interface';

@Injectable()
export class SampleProcessor {
  private readonly logger = new Logger(SampleProcessor.name);

  async process<T, R>(job: JobData<T>): Promise<JobResult<R>> {
    this.logger.log(`Processing job ${job.name} (ID: ${job.id})...`);
    
    // Simulate background work
    await new Promise((resolve) => setTimeout(resolve, 100));

    this.logger.log(`Completed job ${job.name} (ID: ${job.id})`);
    return {
      jobId: job.id,
      success: true,
    };
  }
}
