export interface AppConfig {
  port: number;
  environment: string;
  databaseUrl: string;
  redisUrl: string;
}

export const defaultConfig: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  environment: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/devpulse',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
};
