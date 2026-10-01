import { defaultConfig } from '@devpulse/config';

export class DatabaseClient {
  private url: string;
  private connected: boolean = false;

  constructor(connectionUrl?: string) {
    this.url = connectionUrl || defaultConfig.databaseUrl;
  }

  async connect(): Promise<void> {
    this.connected = true;
    console.log(`Connected to database at ${this.url}`);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    console.log('Disconnected from database');
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export const dbClient = new DatabaseClient();
