import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { DatabaseService } from './database.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly databaseService: DatabaseService,
  ) {}

  @Get()
  getHello(): { message: string; timestamp: string } {
    return this.appService.getHello();
  }

  @Get('health/db')
  async getDatabaseHealth() {
    const health = await this.databaseService.checkHealth();
    return {
      service: 'database',
      ...health,
      timestamp: new Date().toISOString(),
    };
  }
}
