import { Injectable } from '@nestjs/common';
import { config } from '@devpulse/config';
import { Logger } from '@devpulse/logger';
import {
  HealthStatus,
  ComponentHealth,
  HealthCheckResponse,
} from '@devpulse/types';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';

/**
 * Orchestrates health checks across all infrastructure dependencies.
 *
 * Each individual check is wrapped so that a single failing dependency
 * never prevents the rest from being evaluated.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger({ service: 'api', context: HealthService.name });

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redisService: RedisService,
  ) {}

  // ── Liveness ────────────────────────────────────────────────────────

  /**
   * Lightweight liveness probe — confirms the Node process is running
   * and capable of serving HTTP responses.
   */
  getLiveness(): HealthCheckResponse {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      environment: config.app.nodeEnv,
    };
  }

  // ── Readiness ───────────────────────────────────────────────────────

  /**
   * Readiness probe — verifies that every required dependency is
   * reachable and that application configuration loaded successfully.
   */
  async getReadiness(): Promise<HealthCheckResponse> {
    const components = await this.checkAllComponents();
    const status = this.aggregateStatus(components);

    if (status !== 'healthy') {
      this.logger.warn('Readiness check returned unhealthy', {
        status,
        components: components.map((c) => ({ name: c.name, status: c.status })),
      });
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      environment: config.app.nodeEnv,
      components,
    };
  }

  // ── Aggregate (/health) ─────────────────────────────────────────────

  /**
   * Combined health endpoint — includes liveness + readiness data.
   */
  async getOverallHealth(): Promise<HealthCheckResponse> {
    const components = await this.checkAllComponents();
    const status = this.aggregateStatus(components);

    return {
      status,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      environment: config.app.nodeEnv,
      components,
    };
  }

  // ── Individual checks ───────────────────────────────────────────────

  /** Verifies PostgreSQL is reachable via Prisma's `SELECT 1` probe. */
  private async checkDatabase(): Promise<ComponentHealth> {
    try {
      const result = await this.databaseService.checkHealth();
      return {
        name: 'postgresql',
        status: result.status === 'up' ? 'healthy' : 'unhealthy',
        details: result.details,
      };
    } catch (error) {
      return {
        name: 'postgresql',
        status: 'unhealthy',
        details: (error as Error).message,
      };
    }
  }

  /** Pings Redis and includes latency in the response. */
  private async checkRedis(): Promise<ComponentHealth> {
    try {
      const result = await this.redisService.checkHealth();
      return {
        name: 'redis',
        status: result.status === 'up' ? 'healthy' : 'unhealthy',
        latencyMs: result.latencyMs,
        details: result.details,
      };
    } catch (error) {
      return {
        name: 'redis',
        status: 'unhealthy',
        details: (error as Error).message,
      };
    }
  }

  /**
   * Validates that the application configuration loaded without errors.
   * A config that parsed at startup is always valid for the lifetime of
   * the process, but this check makes the health response explicit.
   */
  private checkConfig(): ComponentHealth {
    try {
      const isValid =
        !!config.app.nodeEnv &&
        !!config.database.url &&
        !!config.redis.host;

      return {
        name: 'configuration',
        status: isValid ? 'healthy' : 'unhealthy',
        details: isValid ? undefined : 'One or more required configuration values are missing',
      };
    } catch (error) {
      return {
        name: 'configuration',
        status: 'unhealthy',
        details: (error as Error).message,
      };
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /**
   * Runs all component checks concurrently so one slow dependency
   * does not block the others.
   */
  private async checkAllComponents(): Promise<ComponentHealth[]> {
    const [database, redis] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    const configHealth = this.checkConfig();

    return [database, redis, configHealth];
  }

  /**
   * Derives the top-level status from the set of component results.
   * - All healthy → `healthy`
   * - Any unhealthy → `unhealthy`
   * - Mix of healthy / degraded → `degraded`
   */
  private aggregateStatus(components: ComponentHealth[]): HealthStatus {
    const hasUnhealthy = components.some((c) => c.status === 'unhealthy');
    if (hasUnhealthy) return 'unhealthy';

    const hasDegraded = components.some((c) => c.status === 'degraded');
    if (hasDegraded) return 'degraded';

    return 'healthy';
  }
}
