import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { RedisClient, RedisHealth } from '@devpulse/redis';

/**
 * NestJS-scoped wrapper around RedisClient.
 * Connects on module init and disconnects on module destroy,
 * with graceful error handling so a missing Redis instance does not crash
 * the API at startup.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly redisClient = new RedisClient();
  private readonly logger = new Logger(RedisService.name);

  /** Exposes the raw ioredis instance — used by BullMQ and other utilities. */
  get client(): Redis {
    return this.redisClient.instance;
  }

  async onModuleInit() {
    try {
      await this.redisClient.connect();
      this.logger.log('Successfully connected to Redis');
    } catch (error) {
      this.logger.warn(
        `Initial Redis connection attempt failed: ${(error as Error).message}. ` +
          'The service will retry automatically.',
      );
    }
  }

  async onModuleDestroy() {
    await this.redisClient.disconnect();
    this.logger.log('Redis connection closed');
  }

  /** Pings Redis and returns a structured health result. */
  async checkHealth(): Promise<RedisHealth> {
    return this.redisClient.healthCheck();
  }
}
