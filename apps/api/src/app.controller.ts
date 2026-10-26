import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { DatabaseService } from './database.service';
import { RedisService } from './redis.service';
import { Public, Roles } from './auth';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly databaseService: DatabaseService,
    private readonly redisService: RedisService,
  ) {}

  @Public()
  @Get()
  getHello(): { message: string; timestamp: string } {
    return this.appService.getHello();
  }

  @Roles('ADMIN')
  @Get('health/db')
  async getDatabaseHealth() {
    const health = await this.databaseService.checkHealth();
    return {
      service: 'database',
      ...health,
      timestamp: new Date().toISOString(),
    };
  }

  @Roles('ADMIN')
  @Get('health/redis')
  async getRedisHealth() {
    const health = await this.redisService.checkHealth();
    return {
      service: 'redis',
      ...health,
      timestamp: new Date().toISOString(),
    };
  }
}

