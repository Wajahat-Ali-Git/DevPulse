import { OnModuleDestroy } from '@nestjs/common';
import { Worker, Job, WorkerOptions, ConnectionOptions, UnrecoverableError } from 'bullmq';
import { Logger } from '@devpulse/logger';
import { QueueName } from '@devpulse/types';
import { RedisService } from '../redis/redis.service';
import { resolveQueueConcurrency, DefaultQueueConfigs } from './queue.config';
import { normalizeJobError, isRetryableError } from './job-errors';

export interface BaseWorkerConfig {
  concurrency?: number;
  limiter?: {
    max: number;
    duration: number;
  };
}

/**
 * Abstract BaseWorker providing uniform lifecycle management, connection handling,
 * structured logging, error normalization (retryable vs permanent), and graceful shutdown.
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

    // Resolves concurrency from workerConfig, env variables, or queue default
    const concurrency =
      this.workerConfig?.concurrency ??
      resolveQueueConcurrency(this.queueName);

    const limiter =
      this.workerConfig?.limiter ??
      DefaultQueueConfigs[qName]?.limiter;

    const options: WorkerOptions = {
      connection,
      concurrency,
      limiter,
    };

    this.worker = new Worker<DataType, ResultType>(
      qName,
      async (job: Job<DataType, ResultType>) => {
        try {
          return await this.processJob(job);
        } catch (rawError) {
          // Normalize error: permanent failures become UnrecoverableError so BullMQ won't retry
          const normalized = normalizeJobError(rawError);
          const isRetryable = isRetryableError(rawError);

          this.logger.warn(
            `Job [${job.id}] "${job.name}" encountered ${isRetryable ? 'RETRYABLE' : 'PERMANENT'} failure on [${qName}]: ${normalized.message}`,
            {
              jobId: job.id,
              jobName: job.name,
              queue: qName,
              attemptsMade: job.attemptsMade,
              isRetryable,
            },
          );

          throw normalized;
        }
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
      const isUnrecoverable = error instanceof UnrecoverableError;

      this.logger.error(
        `Job [${jobId}] "${jobName}" failed on [${this.queueName}] ${isUnrecoverable ? '(PERMANENT - NO RETRY)' : '(RETRYING)'}: ${error.message}`,
        {
          jobId,
          jobName,
          queue: this.queueName,
          error: error.message,
          stack: error.stack,
          isPermanent: isUnrecoverable,
        },
      );
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
