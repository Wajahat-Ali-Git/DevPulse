import Redis, { RedisOptions } from 'ioredis';
import { defaultConfig } from '@devpulse/config';

export interface RedisHealth {
  status: 'up' | 'down';
  connected: boolean;
  latencyMs?: number;
  details?: string;
}

/**
 * Parses a Redis URL into ioredis options.
 * Supports: redis://[password@]host[:port][/db]
 */
function parseRedisUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  const options: RedisOptions = {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    lazyConnect: true,
    // Retry strategy: exponential back-off up to 30 s, max 10 attempts
    retryStrategy: (times: number) => {
      if (times > 10) return null; // stop retrying — let the error surface
      return Math.min(times * 500, 30_000);
    },
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };

  if (parsed.password) {
    options.password = decodeURIComponent(parsed.password);
  }

  const db = parsed.pathname?.replace('/', '');
  if (db) {
    options.db = parseInt(db, 10);
  }

  return options;
}

/**
 * RedisClient wraps ioredis with lifecycle helpers (connect / disconnect /
 * health-check) and a graceful error handler so that transient connection
 * issues are logged rather than crashing the process.
 */
export class RedisClient {
  private readonly client: Redis;
  private readonly url: string;

  constructor(url?: string) {
    this.url = url ?? defaultConfig.redisUrl;
    const options = parseRedisUrl(this.url);
    this.client = new Redis(options);

    // Prevent unhandled 'error' events from crashing Node
    this.client.on('error', (err: Error) => {
      // Errors will be surfaced properly when callers await connect() / healthCheck()
      void err; // intentional no-op — errors are handled at the call site
    });
  }

  /** Returns the underlying ioredis instance for direct use (e.g. BullMQ). */
  get instance(): Redis {
    return this.client;
  }

  /** Establishes the connection; throws on failure. */
  async connect(): Promise<void> {
    await this.client.connect();
  }

  /** Gracefully closes the connection. */
  async disconnect(): Promise<void> {
    await this.client.quit();
  }

  /**
   * Pings Redis and measures round-trip latency.
   * Returns a structured health result — never throws.
   */
  async healthCheck(): Promise<RedisHealth> {
    try {
      const start = Date.now();
      const pong = await this.client.ping();
      const latencyMs = Date.now() - start;

      if (pong === 'PONG') {
        return { status: 'up', connected: true, latencyMs };
      }

      return {
        status: 'down',
        connected: false,
        details: `Unexpected PING response: ${pong}`,
      };
    } catch (error) {
      return {
        status: 'down',
        connected: false,
        details: (error as Error).message,
      };
    }
  }
}
