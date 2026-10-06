import { PrismaClient } from '@prisma/client';
import { defaultConfig } from '@devpulse/config';

export * from '@prisma/client';

export interface PrismaClientOptions {
  datasources?: {
    db?: {
      url?: string;
    };
  };
  log?: Array<'query' | 'info' | 'warn' | 'error'>;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const createPrismaClient = (connectionUrl?: string): PrismaClient => {
  const url = connectionUrl || defaultConfig.databaseUrl;

  return new PrismaClient({
    datasources: {
      db: {
        url,
      },
    },
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export class DatabaseClient {
  private prismaClient: PrismaClient;
  private connected: boolean = false;

  constructor(connectionUrl?: string) {
    this.prismaClient = createPrismaClient(connectionUrl);
  }

  get client(): PrismaClient {
    return this.prismaClient;
  }

  async connect(): Promise<void> {
    await this.prismaClient.$connect();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await this.prismaClient.$disconnect();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.prismaClient.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}

export const dbClient = new DatabaseClient();
