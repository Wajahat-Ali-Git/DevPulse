import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { z } from 'zod';
import { envSchema, RawEnv } from './schema';

// Attempt to load .env from process.cwd() and monorepo root if accessible
dotenv.config();

const potentialRootEnv = path.resolve(process.cwd(), '../../.env');
if (fs.existsSync(potentialRootEnv)) {
  dotenv.config({ path: potentialRootEnv, override: false });
}

export interface ApplicationConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  workerPort: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
}

export interface DatabaseConfig {
  url: string;
  user: string;
  password: string;
  db: string;
  port: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  url: string;
}

export interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  webhookSecret: string;
}

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  sessionSecret: string;
}

export interface EncryptionConfig {
  key: string;
}

export interface UrlsConfig {
  web: string;
  api: string;
  worker: string;
}

export interface PublicConfig {
  env: 'development' | 'production' | 'test';
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  apiPort: number;
  workerPort: number;
  logLevel: string;
  urls: UrlsConfig;
  github: {
    clientId: string;
    callbackUrl: string;
  };
}

export interface PrivateConfig {
  database: DatabaseConfig;
  redis: RedisConfig;
  auth: AuthConfig;
  encryption: EncryptionConfig;
  github: {
    clientSecret: string;
    webhookSecret: string;
  };
}

export interface AppConfig {
  app: ApplicationConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  github: GitHubConfig;
  auth: AuthConfig;
  encryption: EncryptionConfig;
  urls: UrlsConfig;
  public: PublicConfig;
  private: PrivateConfig;
}

function formatValidationError(error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `  - [${issue.path.join('.')}]: ${issue.message}`)
    .join('\n');

  return [
    '====================================================================',
    ' ❌ DEVPULSE CONFIGURATION ERROR: Invalid environment variables!',
    '====================================================================',
    issues,
    '====================================================================',
    ' Please check your .env file or environment settings.',
    ' Refer to .env.example for required configuration parameters.',
    '====================================================================',
  ].join('\n');
}

export function validateConfig(customEnv?: Record<string, string | undefined>): AppConfig {
  const envToValidate = customEnv || process.env;

  // Enforce required secrets in production mode
  const nodeEnv = envToValidate.NODE_ENV || 'development';
  if (nodeEnv === 'production') {
    const missingSecrets: string[] = [];
    const requiredProdSecrets = [
      'DATABASE_URL',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      'GITHUB_WEBHOOK_SECRET',
      'JWT_SECRET',
      'SESSION_SECRET',
      'ENCRYPTION_KEY',
    ];

    for (const secret of requiredProdSecrets) {
      if (!envToValidate[secret] || envToValidate[secret]?.startsWith('dev_') || envToValidate[secret]?.includes('super_secret')) {
        missingSecrets.push(secret);
      }
    }

    if (missingSecrets.length > 0) {
      const errorMsg = [
        '====================================================================',
        ' ❌ DEVPULSE FATAL ERROR: Missing required production secrets!',
        '====================================================================',
        ...missingSecrets.map((s) => `  - [${s}]: Production secret is missing or using insecure default`),
        '====================================================================',
      ].join('\n');

      console.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  const result = envSchema.safeParse(envToValidate);

  if (!result.success) {
    const errorMsg = formatValidationError(result.error);
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  const raw: RawEnv = result.data;

  const redisUrl =
    raw.REDIS_URL ||
    `redis://${raw.REDIS_PASSWORD ? `:${raw.REDIS_PASSWORD}@` : ''}${raw.REDIS_HOST}:${raw.REDIS_PORT}`;

  const applicationConfig: ApplicationConfig = {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    workerPort: raw.WORKER_PORT,
    logLevel: raw.LOG_LEVEL,
    isProduction: raw.NODE_ENV === 'production',
    isDevelopment: raw.NODE_ENV === 'development',
    isTest: raw.NODE_ENV === 'test',
  };

  const databaseConfig: DatabaseConfig = {
    url: raw.DATABASE_URL,
    user: raw.POSTGRES_USER,
    password: raw.POSTGRES_PASSWORD,
    db: raw.POSTGRES_DB,
    port: raw.POSTGRES_PORT,
  };

  const redisConfig: RedisConfig = {
    host: raw.REDIS_HOST,
    port: raw.REDIS_PORT,
    password: raw.REDIS_PASSWORD || undefined,
    url: redisUrl,
  };

  const githubConfig: GitHubConfig = {
    clientId: raw.GITHUB_CLIENT_ID,
    clientSecret: raw.GITHUB_CLIENT_SECRET,
    callbackUrl: raw.GITHUB_CALLBACK_URL,
    webhookSecret: raw.GITHUB_WEBHOOK_SECRET,
  };

  const authConfig: AuthConfig = {
    jwtSecret: raw.JWT_SECRET,
    jwtExpiresIn: raw.JWT_EXPIRES_IN,
    sessionSecret: raw.SESSION_SECRET,
  };

  const encryptionConfig: EncryptionConfig = {
    key: raw.ENCRYPTION_KEY,
  };

  const urlsConfig: UrlsConfig = {
    web: raw.WEB_URL,
    api: raw.API_URL,
    worker: raw.WORKER_URL,
  };

  const publicConfig: PublicConfig = {
    env: raw.NODE_ENV,
    isProduction: raw.NODE_ENV === 'production',
    isDevelopment: raw.NODE_ENV === 'development',
    isTest: raw.NODE_ENV === 'test',
    apiPort: raw.PORT,
    workerPort: raw.WORKER_PORT,
    logLevel: raw.LOG_LEVEL,
    urls: urlsConfig,
    github: {
      clientId: raw.GITHUB_CLIENT_ID,
      callbackUrl: raw.GITHUB_CALLBACK_URL,
    },
  };

  const privateConfig: PrivateConfig = {
    database: databaseConfig,
    redis: redisConfig,
    auth: authConfig,
    encryption: encryptionConfig,
    github: {
      clientSecret: raw.GITHUB_CLIENT_SECRET,
      webhookSecret: raw.GITHUB_WEBHOOK_SECRET,
    },
  };

  return {
    app: applicationConfig,
    database: databaseConfig,
    redis: redisConfig,
    github: githubConfig,
    auth: authConfig,
    encryption: encryptionConfig,
    urls: urlsConfig,
    public: publicConfig,
    private: privateConfig,
  };
}

// Initial configuration object loaded at module import time
export const config: AppConfig = validateConfig();

export function getPublicConfig(): PublicConfig {
  return config.public;
}

export function getPrivateConfig(): PrivateConfig {
  return config.private;
}

// Legacy fallback export for backward compatibility
export const defaultConfig = {
  port: config.app.port,
  environment: config.app.nodeEnv,
  databaseUrl: config.database.url,
  redisUrl: config.redis.url,
};
