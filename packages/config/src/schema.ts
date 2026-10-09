import { z } from 'zod';

export const envSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive('PORT must be a positive integer').default(3000),
  WORKER_PORT: z.coerce.number().int().positive('WORKER_PORT must be a positive integer').default(3002),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Database
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .default('postgresql://postgres:postgres@localhost:5433/devpulse'),
  POSTGRES_USER: z.string().default('postgres'),
  POSTGRES_PASSWORD: z.string().default('postgres'),
  POSTGRES_DB: z.string().default('devpulse'),
  POSTGRES_PORT: z.coerce.number().int().positive('POSTGRES_PORT must be a positive integer').default(5433),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive('REDIS_PORT must be a positive integer').default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_URL: z.string().optional(),

  // GitHub OAuth
  GITHUB_CLIENT_ID: z
    .string()
    .min(1, 'GITHUB_CLIENT_ID is required')
    .default('dev_github_client_id'),
  GITHUB_CLIENT_SECRET: z
    .string()
    .min(1, 'GITHUB_CLIENT_SECRET is required')
    .default('dev_github_client_secret'),
  GITHUB_CALLBACK_URL: z
    .string()
    .url('GITHUB_CALLBACK_URL must be a valid URL')
    .default('http://localhost:3000/api/v1/auth/github/callback'),

  // GitHub Webhooks
  GITHUB_WEBHOOK_SECRET: z
    .string()
    .min(1, 'GITHUB_WEBHOOK_SECRET is required')
    .default('dev_github_webhook_secret'),

  // Authentication
  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET must be at least 16 characters long')
    .default('devpulse_super_secret_jwt_key_32bytes!'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  SESSION_SECRET: z
    .string()
    .min(16, 'SESSION_SECRET must be at least 16 characters long')
    .default('devpulse_super_secret_session_key_32bytes!'),

  // Encryption
  ENCRYPTION_KEY: z
    .string()
    .min(16, 'ENCRYPTION_KEY must be at least 16 characters long')
    .default('devpulse_32byte_encryption_key_123!'),

  // URLs
  WEB_URL: z.string().url('WEB_URL must be a valid URL').default('http://localhost:3000'),
  API_URL: z.string().url('API_URL must be a valid URL').default('http://localhost:3001'),
  WORKER_URL: z.string().url('WORKER_URL must be a valid URL').default('http://localhost:3002'),
});

export type RawEnv = z.infer<typeof envSchema>;
