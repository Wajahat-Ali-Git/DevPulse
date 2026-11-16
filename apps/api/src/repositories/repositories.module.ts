import { Module } from '@nestjs/common';
import { RepositoriesController } from './repositories.controller';
import { SyncController } from './sync.controller';
import { RepositorySyncService } from './repository-sync.service';
import { RepositorySyncQueueService } from './repository-sync-queue.service';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';

@Module({
  controllers: [RepositoriesController, SyncController],
  providers: [
    RepositorySyncService,
    RepositorySyncQueueService,
    DatabaseService,
    RedisService,
  ],
  exports: [RepositorySyncService, RepositorySyncQueueService],
})
export class RepositoriesModule {}



