import { Injectable } from '@nestjs/common';
import { Logger, CorrelationContext } from '@devpulse/logger';
import { JobData, JobResult } from '../jobs/job.interface';

@Injectable()
export class SampleProcessor {
  private readonly logger = new Logger({ service: 'worker', context: SampleProcessor.name });

  async process<T, R>(job: JobData<T>): Promise<JobResult<R>> {
    return CorrelationContext.run({ service: 'worker', jobId: job.id }, async () => {
      this.logger.info(`Processing job ${job.name} (ID: ${job.id})...`, {
        jobName: job.name,
        jobId: job.id,
      });

      // Simulate background work
      await new Promise((resolve) => setTimeout(resolve, 100));

      this.logger.info(`Completed job ${job.name} (ID: ${job.id})`, {
        jobName: job.name,
        jobId: job.id,
      });
      return {
        jobId: job.id,
        success: true,
      };
    });
  }
}
