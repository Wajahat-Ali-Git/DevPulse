import { OnModuleDestroy } from '@nestjs/common';
import { Worker, Job, WorkerOptions, ConnectionOptions, UnrecoverableError } from 'bullmq';
import { Logger, CorrelationContext } from '@devpulse/logger';
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

export interface FailedJobDetails {
  jobId: string;
  jobName: string;
  queue: string;
  attemptsMade: number;
  maxAttempts: number;
  isPermanent: boolean;
  errorMessage: string;
  failedReason?: string;
  stack?: string;
  correlationId?: string;
  failedAt: string;
  payload?: any;
}

/**
 * Abstract BaseWorker providing uniform lifecycle management, connection handling,
 * structured logging with correlation IDs, failed-job handling, and safe shutdown.
 */
export abstract class BaseWorker<DataType = any, ResultType = any> implements OnModuleDestroy {
  protected abstract readonly queueName: QueueName | string;
  protected readonly logger: Logger;
  protected worker?: Worker<DataType, ResultType>;
  private isShuttingDown = false;

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
        // Extract or generate job correlation ID
        const correlationId =
          (job.data as any)?.correlationId ||
          (job.data as any)?.deliveryId ||
          job.opts?.jobId ||
          `job_corr_${job.id}`;

        return CorrelationContext.run(
          {
            service: 'worker',
            context: this.constructor.name,
            jobId: String(job.id),
            correlationId: String(correlationId),
          },
          async () => {
            const startTime = Date.now();
            this.logger.info(`Starting job execution [${job.id}] "${job.name}" on [${qName}]`, {
              jobId: job.id,
              jobName: job.name,
              queue: qName,
              correlationId,
              attemptsMade: job.attemptsMade,
              maxAttempts: job.opts?.attempts ?? 1,
            });

            try {
              const result = await this.processJob(job);
              const durationMs = Date.now() - startTime;

              this.logger.info(`Job execution [${job.id}] "${job.name}" completed successfully in ${durationMs}ms`, {
                jobId: job.id,
                jobName: job.name,
                queue: qName,
                durationMs,
                correlationId,
              });

              return result;
            } catch (rawError) {
              const durationMs = Date.now() - startTime;
              const normalized = normalizeJobError(rawError);
              const isRetryable = isRetryableError(rawError);
              const isPermanent = !isRetryable;

              this.logger.warn(
                `Job execution [${job.id}] "${job.name}" failed after ${durationMs}ms with ${isPermanent ? 'PERMANENT' : 'RETRYABLE'} failure: ${normalized.message}`,
                {
                  jobId: job.id,
                  jobName: job.name,
                  queue: qName,
                  durationMs,
                  correlationId,
                  attemptsMade: job.attemptsMade,
                  maxAttempts: job.opts?.attempts ?? 1,
                  isPermanent,
                  error: normalized.message,
                  stack: normalized.stack,
                },
              );

              // Hook for failed job processing
              await this.handleFailedJob({
                jobId: String(job.id),
                jobName: job.name,
                queue: qName,
                attemptsMade: job.attemptsMade + 1,
                maxAttempts: job.opts?.attempts ?? 1,
                isPermanent,
                errorMessage: normalized.message,
                failedReason: normalized.message,
                stack: normalized.stack,
                correlationId: String(correlationId),
                failedAt: new Date().toISOString(),
                payload: job.data,
              });

              throw normalized;
            }
          },
        );
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
   * Hook executed whenever a job fails, providing structured failure capture,
   * dead-letter routing diagnostics, and error reporting.
   */
  protected async handleFailedJob(details: FailedJobDetails): Promise<void> {
    const isExhausted = details.attemptsMade >= details.maxAttempts;

    if (details.isPermanent || isExhausted) {
      this.logger.error(
        `Job [${details.jobId}] "${details.jobName}" exhausted retries or suffered permanent failure on [${details.queue}]. Routing to Dead-Letter/Failed set.`,
        {
          jobId: details.jobId,
          jobName: details.jobName,
          queue: details.queue,
          correlationId: details.correlationId,
          attemptsMade: details.attemptsMade,
          maxAttempts: details.maxAttempts,
          isPermanent: details.isPermanent,
          isExhausted,
          errorMessage: details.errorMessage,
          failedAt: details.failedAt,
        },
      );
    }
  }

  /**
   * Registers default lifecycle event listeners for logging and observability.
   */
  protected registerEventListeners(): void {
    if (!this.worker) return;

    this.worker.on('completed', (job: Job<DataType, ResultType>) => {
      this.logger.info(`Job [${job.id}] "${job.name}" acknowledged complete by queue [${this.queueName}]`, {
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
        `Job [${jobId}] "${jobName}" moved to failed state on [${this.queueName}] ${isUnrecoverable ? '(PERMANENT - NO RETRY)' : '(RETRYING)'}: ${error.message}`,
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
   * Returns whether the worker is currently running and active.
   */
  public isRunning(): boolean {
    return !!this.worker && this.worker.isRunning() && !this.isShuttingDown;
  }

  /**
   * Returns the underlying BullMQ Worker instance.
   */
  public getWorkerInstance(): Worker<DataType, ResultType> | undefined {
    return this.worker;
  }

  /**
   * Performs safe graceful shutdown of the worker, waiting for active jobs to complete.
   */
  public async safeShutdown(timeoutMs = 10000): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    if (!this.worker) return;

    this.logger.log(`Initiating safe shutdown for worker [${this.queueName}] (timeout: ${timeoutMs}ms)...`);

    try {
      // Pause worker first so it stops picking up new jobs from Redis
      await this.worker.pause(true);

      // Close worker gracefully, allowing in-flight jobs to finish
      const closePromise = this.worker.close();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Worker shutdown timed out after ${timeoutMs}ms`)), timeoutMs),
      );

      await Promise.race([closePromise, timeoutPromise]);
      this.logger.log(`Worker for queue [${this.queueName}] shutdown cleanly.`);
    } catch (error) {
      this.logger.error(`Forced worker closure on [${this.queueName}] due to timeout/error: ${(error as Error).message}`);
    }
  }

  /**
   * Graceful shutdown hook for NestJS module lifecycle.
   */
  async onModuleDestroy(): Promise<void> {
    await this.safeShutdown();
  }
}
