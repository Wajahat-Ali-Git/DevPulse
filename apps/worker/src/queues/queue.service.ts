import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, ConnectionOptions, JobsOptions } from 'bullmq';
import { Logger } from '@devpulse/logger';
import { QueueName, JobName, JobPayloadMap } from '@devpulse/types';
import { RedisService } from '../redis/redis.service';
import { JobData } from '../jobs/job.interface';
import { resolveQueueRetryPolicy, RetryPolicy } from './queue.config';

export interface TypedEnqueueOptions extends JobsOptions {
  correlationId?: string;
  retryPolicy?: RetryPolicy;
}

/**
 * QueueService manages BullMQ Queue instances and provides typed
 * methods for enqueuing background jobs across DevPulse.
 *
 * BullMQ shares the Redis connection managed by RedisService.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger({ service: 'worker', context: QueueService.name });
  private readonly queues = new Map<string, Queue>();
  private isShuttingDown = false;

  constructor(private readonly redisService: RedisService) {}

  /**
   * Returns an existing BullMQ Queue or creates a new one for the given name.
   * All queues share the same Redis connection options and apply resolved retry/backoff policies.
   */
  public getOrCreateQueue(queueName: string | QueueName): Queue {
    const qName = queueName.toString();
    if (!this.queues.has(qName)) {
      const connection: ConnectionOptions = this.redisService.client;
      const retryPolicy = resolveQueueRetryPolicy(qName);

      const queue = new Queue(qName, {
        connection,
        defaultJobOptions: {
          attempts: retryPolicy.attempts,
          backoff: retryPolicy.backoff,
          removeOnComplete: {
            count: 1000,
            age: 24 * 3600,
          },
          removeOnFail: {
            count: 5000,
            age: 7 * 24 * 3600,
          },
        },
      });
      this.queues.set(qName, queue);
      this.logger.log(
        `BullMQ queue registered: [${qName}] (attempts: ${retryPolicy.attempts}, backoff: ${retryPolicy.backoff.type}/${retryPolicy.backoff.delay}ms)`,
      );
    }
    return this.queues.get(qName)!;
  }

  /**
   * Strongly-typed helper to add a job with payload corresponding to JobName.
   */
  async addTypedJob<K extends keyof JobPayloadMap>(
    queueName: QueueName | string,
    jobName: K,
    payload: JobPayloadMap[K],
    options?: TypedEnqueueOptions,
  ): Promise<JobData<JobPayloadMap[K]>> {
    const enqueueOptions: JobsOptions = { ...options };
    if (options?.retryPolicy) {
      enqueueOptions.attempts = options.retryPolicy.attempts;
      enqueueOptions.backoff = options.retryPolicy.backoff;
    }

    // Attach correlationId to payload if not already present
    const payloadCorr = (payload as any)?.correlationId || (payload as any)?.deliveryId;
    const correlationId = options?.correlationId || payloadCorr || `corr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const enrichedPayload = {
      ...payload,
      correlationId,
    };

    return this.addJob<JobPayloadMap[K]>(queueName, jobName, enrichedPayload, enqueueOptions);
  }

  /**
   * Adds a named job to the specified BullMQ queue.
   * Returns the BullMQ Job object representation with auto-generated ID.
   */
  async addJob<T>(
    queueName: string | QueueName,
    name: string,
    payload: T,
    options?: JobsOptions,
  ): Promise<JobData<T>> {
    const queue = this.getOrCreateQueue(queueName);

    const job = await queue.add(name, payload, options);

    const jobData: JobData<T> = {
      id: job.id ?? `job_${Date.now()}`,
      name,
      payload,
      createdAt: new Date(job.timestamp || Date.now()),
    };

    const correlationId = (payload as any)?.correlationId || job.opts?.jobId || jobData.id;
    this.logger.log(`Job [${jobData.id}] "${name}" added to queue [${queueName}] (corr: ${correlationId})`, {
      jobId: jobData.id,
      jobName: name,
      queue: queueName,
      correlationId,
    });
    return jobData;
  }

  /**
   * Returns an array of all active queue names currently managed.
   */
  getRegisteredQueueNames(): string[] {
    return Array.from(this.queues.keys());
  }

  /**
   * Safe graceful shutdown of all queues.
   */
  async safeShutdown(timeoutMs = 10000): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.log(`Closing ${this.queues.size} BullMQ queue(s) gracefully...`);
    const closePromises = Array.from(this.queues.values()).map(async (q) => {
      try {
        await q.close();
      } catch (err) {
        this.logger.warn(`Error closing queue ${q.name}: ${(err as Error).message}`);
      }
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Queue closure timed out after ${timeoutMs}ms`)), timeoutMs),
    );

    try {
      await Promise.race([Promise.all(closePromises), timeoutPromise]);
      this.logger.log(`Closed ${this.queues.size} BullMQ queue(s) successfully`);
    } catch (err) {
      this.logger.error(`Queue shutdown timeout/error: ${(err as Error).message}`);
    }
  }

  /** Gracefully closes all managed queues on shutdown. */
  async onModuleDestroy() {
    await this.safeShutdown();
  }
}
