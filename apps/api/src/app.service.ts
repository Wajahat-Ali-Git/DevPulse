import { Injectable } from '@nestjs/common';
import { defaultConfig } from '@devpulse/config';
import { Logger } from '@devpulse/logger';
import { User } from '@devpulse/types';

@Injectable()
export class AppService {
  private logger = new Logger('AppService');

  getHello(): { message: string; timestamp: string; env: string; sampleUser: Partial<User> } {
    this.logger.info('Fetching hello payload in API');
    return {
      message: 'DevPulse API Operational',
      timestamp: new Date().toISOString(),
      env: defaultConfig.environment,
      sampleUser: {
        id: 'usr_1',
        name: 'DevPulse User',
        email: 'user@devpulse.local',
      },
    };
  }
}
