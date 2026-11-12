import { Module } from '@nestjs/common';
import { RepositoriesController } from './repositories.controller';
import { RepositorySyncService } from './repository-sync.service';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';

@Module({
  controllers: [RepositoriesController],
  providers: [RepositorySyncService, DatabaseService, RedisService],
  exports: [RepositorySyncService],
})
export class RepositoriesModule {}

