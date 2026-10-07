import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Job, ConnectionOptions } from 'bullmq';
import { RedisService } from '../redis/redis.service';
import { JobData } from '../jobs/job.interface';

/**
 * QueueService manages BullMQ Queue instances and provides a single
 * entry-point for enqueuing jobs from anywhere in the worker application.
 *
 * BullMQ shares the ioredis connection managed by RedisService so there
 * is only one connection pool for the entire Worker process.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly redisService: RedisService) {}

  /**
   * Returns an existing BullMQ Queue or creates a new one for the given name.
   * All queues share the same Redis connection options.
   */
  private getOrCreateQueue(queueName: string): Queue {
    if (!this.queues.has(queueName)) {
      const connection: ConnectionOptions = this.redisService.client;
      const queue = new Queue(queueName, { connection });
      this.queues.set(queueName, queue);
      this.logger.log(`BullMQ queue registered: [${queueName}]`);
    }
    return this.queues.get(queueName)!;
  }

  /**
   * Adds a named job to the specified BullMQ queue.
   * Returns the BullMQ Job object that includes the auto-generated ID.
   */
  async addJob<T>(queueName: string, name: string, payload: T): Promise<JobData<T>> {
    const queue = this.getOrCreateQueue(queueName);

    const job: Job<T> = await queue.add(name, payload);

    const jobData: JobData<T> = {
      id: job.id ?? `job_${Date.now()}`,
      name,
      payload,
      createdAt: new Date(),
    };

    this.logger.log(`Job [${jobData.id}] "${name}" added to queue [${queueName}]`);
    return jobData;
  }

  /** Gracefully closes all managed queues on shutdown. */
  async onModuleDestroy() {
    const closePromises = Array.from(this.queues.values()).map((q) => q.close());
    await Promise.all(closePromises);
    this.logger.log(`Closed ${this.queues.size} BullMQ queue(s)`);
  }
}
