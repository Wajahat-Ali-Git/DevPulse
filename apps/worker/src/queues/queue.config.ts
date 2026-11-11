import { BackoffOptions, JobsOptions } from 'bullmq';
import { QueueName } from '@devpulse/types';

/**
 * Retry and Backoff Policy options for BullMQ queues and jobs.
 */
export interface RetryPolicy {
  /** Total retry attempts before moving job to failed state. */
  attempts: number;
  /** Backoff strategy configuration. */
  backoff: BackoffOptions;
}

/**
 * Queue-level configuration settings including concurrency and retry policy.
 */
export interface QueueConfig {
  /** Maximum number of jobs a worker processes concurrently. */
  concurrency: number;
  /** Retry and backoff policy for jobs in this queue. */
  retryPolicy: RetryPolicy;
  /** Rate limiter configuration (optional). */
  limiter?: {
    max: number;
    duration: number;
  };
}

/**
 * Standard retry policies available across DevPulse background processing.
 */
export const RetryPolicies = {
  /** Fast exponential backoff: 3 attempts, starting at 500ms (500ms, 1s, 2s). */
  FAST_EXPONENTIAL: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 500,
    },
  } satisfies RetryPolicy,

  /** Standard exponential backoff: 3 attempts, starting at 1000ms (1s, 2s, 4s). */
  STANDARD_EXPONENTIAL: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  } satisfies RetryPolicy,

  /** Heavy exponential backoff for external API sync: 5 attempts, starting at 2000ms (2s, 4s, 8s, 16s, 32s). */
  HEAVY_API_EXPONENTIAL: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  } satisfies RetryPolicy,

  /** Linear backoff: 3 attempts, fixed 2000ms delay. */
  LINEAR: {
    attempts: 3,
    backoff: {
      type: 'fixed',
      delay: 2000,
    },
  } satisfies RetryPolicy,

  /** Strict non-retry policy: 1 attempt only, failures immediately terminal. */
  NO_RETRY: {
    attempts: 1,
    backoff: {
      type: 'fixed',
      delay: 0,
    },
  } satisfies RetryPolicy,
};

/**
 * Default configurations per queue name with sensible concurrency and retry strategies.
 * Can be overridden via environment variables or worker constructors.
 */
export const DefaultQueueConfigs: Record<string, QueueConfig> = {
  [QueueName.GITHUB_WEBHOOKS]: {
    concurrency: 10,
    retryPolicy: RetryPolicies.STANDARD_EXPONENTIAL,
  },
  [QueueName.REPOSITORY_SYNC]: {
    concurrency: 5,
    retryPolicy: RetryPolicies.HEAVY_API_EXPONENTIAL,
    limiter: {
      max: 30,
      duration: 60_000, // Safe GitHub rate-limit guard
    },
  },
  [QueueName.METRICS_CALCULATION]: {
    concurrency: 3,
    retryPolicy: RetryPolicies.STANDARD_EXPONENTIAL,
  },
  [QueueName.NOTIFICATIONS]: {
    concurrency: 5,
    retryPolicy: RetryPolicies.FAST_EXPONENTIAL,
  },
  [QueueName.SAMPLE]: {
    concurrency: 2,
    retryPolicy: RetryPolicies.FAST_EXPONENTIAL,
  },
};

/**
 * Resolves concurrency for a queue, allowing override via process.env.
 * E.g., WORKER_CONCURRENCY_GITHUB_WEBHOOKS or WORKER_CONCURRENCY.
 */
export function resolveQueueConcurrency(queueName: string | QueueName, defaultConcurrency = 5): number {
  const envKey = `WORKER_CONCURRENCY_${queueName.toString().toUpperCase().replace(/-/g, '_')}`;
  const specificEnv = process.env[envKey];
  if (specificEnv && !Number.isNaN(parseInt(specificEnv, 10))) {
    return parseInt(specificEnv, 10);
  }

  const globalEnv = process.env.WORKER_CONCURRENCY;
  if (globalEnv && !Number.isNaN(parseInt(globalEnv, 10))) {
    return parseInt(globalEnv, 10);
  }

  return DefaultQueueConfigs[queueName.toString()]?.concurrency ?? defaultConcurrency;
}

/**
 * Resolves retry policy for a queue, allowing override via process.env.
 * E.g., WORKER_RETRY_ATTEMPTS or WORKER_RETRY_DELAY_MS.
 */
export function resolveQueueRetryPolicy(queueName: string | QueueName): RetryPolicy {
  const basePolicy = DefaultQueueConfigs[queueName.toString()]?.retryPolicy ?? RetryPolicies.STANDARD_EXPONENTIAL;

  const attemptsEnv = process.env.WORKER_RETRY_ATTEMPTS;
  const attempts = attemptsEnv && !Number.isNaN(parseInt(attemptsEnv, 10))
    ? parseInt(attemptsEnv, 10)
    : basePolicy.attempts;

  const delayEnv = process.env.WORKER_RETRY_DELAY_MS;
  const delay = delayEnv && !Number.isNaN(parseInt(delayEnv, 10))
    ? parseInt(delayEnv, 10)
    : (basePolicy.backoff.delay ?? 1000);

  return {
    attempts,
    backoff: {
      type: basePolicy.backoff.type,
      delay,
    },
  };
}
