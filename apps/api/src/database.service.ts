import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { DatabaseClient, PrismaClient } from '@devpulse/database';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly dbClient = new DatabaseClient();
  private readonly logger = new Logger(DatabaseService.name);

  get client(): PrismaClient {
    return this.dbClient.client;
  }

  async onModuleInit() {
    try {
      await this.dbClient.connect();
      this.logger.log('Successfully established connection to PostgreSQL database via Prisma');
    } catch (error) {
      this.logger.warn(`Initial database connection attempt failed: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.dbClient.disconnect();
    this.logger.log('Database connection disconnected');
  }

  async checkHealth(): Promise<{ status: string; connected: boolean; details?: string }> {
    const isHealthy = await this.dbClient.healthCheck();
    return {
      status: isHealthy ? 'up' : 'down',
      connected: isHealthy,
    };
  }
}
