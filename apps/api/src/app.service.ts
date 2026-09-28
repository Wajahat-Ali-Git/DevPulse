import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): { message: string; timestamp: string } {
    return {
      message: 'DevPulse API Operational',
      timestamp: new Date().toISOString(),
    };
  }
}
