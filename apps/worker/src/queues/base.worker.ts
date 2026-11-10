import { OnModuleDestroy } from '@nestjs/common';
import { Worker, Job, WorkerOptions, ConnectionOptions } from 'bullmq';
import { Logger } from '@devpulse/logger';
import { QueueName } from '@devpulse/types';
import { RedisService } from '../redis/redis.service';

export interface BaseWorkerConfig {
  concurrency?: number;
  limiter?: {
    max: number;
    duration: number;
  };
}

/**
 * Abstract BaseWorker providing uniform lifecycle management, connection handling,
 * structured logging, error handling, and graceful shutdown for BullMQ workers.
 */
export abstract class BaseWorker<DataType = any, ResultType = any> implements OnModuleDestroy {
  protected abstract readonly queueName: QueueName | string;
  protected readonly logger: Logger;
  protected worker?: Worker<DataType, ResultType>;

  constructor(
    protected readonly redisService: RedisService,
    contextName: string,
    protected readonly workerConfig?: BaseWorkerConfig,
  ) {
    this.logger = new Logger({ service: 'worker', context: contextName });
  }

  /**
   * Initializes and starts the BullMQ Worker instance.
   */
  public startWorker(): Worker<DataType, ResultType> {
    if (this.worker) {
      return this.worker;
    }

    const connection: ConnectionOptions = this.redisService.client;
    const qName = this.queueName.toString();

    const options: WorkerOptions = {
      connection,
      concurrency: this.workerConfig?.concurrency ?? 5,
      limiter: this.workerConfig?.limiter,
    };

    this.worker = new Worker<DataType, ResultType>(
      qName,
      async (job: Job<DataType, ResultType>) => {
        return this.processJob(job);
      },
      options,
    );

    this.registerEventListeners();
    this.logger.log(`BullMQ worker started for queue [${qName}] (concurrency: ${options.concurrency})`);

    return this.worker;
  }

  /**
   * Abstract method implemented by concrete workers to process jobs.
   */
  abstract processJob(job: Job<DataType, ResultType>): Promise<ResultType>;

  /**
   * Registers default lifecycle event listeners for logging and observability.
   */
  protected registerEventListeners(): void {
    if (!this.worker) return;

    this.worker.on('completed', (job: Job<DataType, ResultType>) => {
      this.logger.info(`Job [${job.id}] "${job.name}" completed successfully on [${this.queueName}]`, {
        jobId: job.id,
        jobName: job.name,
        queue: this.queueName,
      });
    });

    this.worker.on('failed', (job: Job<DataType, ResultType> | undefined, error: Error) => {
      const jobId = job?.id ?? 'unknown';
      const jobName = job?.name ?? 'unknown';
      this.logger.error(`Job [${jobId}] "${jobName}" failed on [${this.queueName}]: ${error.message}`, {
        jobId,
        jobName,
        queue: this.queueName,
        error: error.message,
        stack: error.stack,
      });
    });

    this.worker.on('error', (err: Error) => {
      this.logger.error(`Worker error on queue [${this.queueName}]: ${err.message}`, {
        queue: this.queueName,
        error: err.message,
      });
    });

    this.worker.on('stalled', (jobId: string) => {
      this.logger.warn(`Job [${jobId}] stalled on queue [${this.queueName}]`, {
        jobId,
        queue: this.queueName,
      });
    });
  }

  /**
   * Returns whether the worker is currently running.
   */
  public isRunning(): boolean {
    return !!this.worker && this.worker.isRunning();
  }

  /**
   * Returns the underlying BullMQ Worker instance.
   */
  public getWorkerInstance(): Worker<DataType, ResultType> | undefined {
    return this.worker;
  }

  /**
   * Graceful shutdown hook.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      this.logger.log(`Closing worker for queue [${this.queueName}]...`);
      await this.worker.close();
      this.logger.log(`Worker for queue [${this.queueName}] stopped gracefully.`);
    }
  }
}
