import * as assert from 'node:assert';
import { HealthService } from './health.service';
import { HealthController } from './health.controller';
import { HttpStatus } from '@nestjs/common';

async function runTests() {
  console.log('Running Health Module Unit Tests...');

  // 1. HealthService Liveness
  {
    const mockDbService = {
      checkHealth: async () => ({ status: 'up', connected: true }),
    } as any;
    const mockRedisService = {
      checkHealth: async () => ({ status: 'up', connected: true, latencyMs: 2 }),
    } as any;

    const healthService = new HealthService(mockDbService, mockRedisService);
    const liveness = healthService.getLiveness();

    assert.strictEqual(liveness.status, 'healthy');
    assert.strictEqual(typeof liveness.uptimeSeconds, 'number');
    assert.ok(liveness.timestamp);
    assert.strictEqual(liveness.components, undefined);
    console.log('✔ HealthService getLiveness() returns healthy without components');
  }

  // 2. HealthService Readiness - All healthy
  {
    const mockDbService = {
      checkHealth: async () => ({ status: 'up', connected: true }),
    } as any;
    const mockRedisService = {
      checkHealth: async () => ({ status: 'up', connected: true, latencyMs: 5 }),
    } as any;

    const healthService = new HealthService(mockDbService, mockRedisService);
    const readiness = await healthService.getReadiness();

    assert.strictEqual(readiness.status, 'healthy');
    assert.ok(Array.isArray(readiness.components));
    assert.strictEqual(readiness.components!.length, 3);

    const postgres = readiness.components!.find((c) => c.name === 'postgresql');
    const redis = readiness.components!.find((c) => c.name === 'redis');
    const configComp = readiness.components!.find((c) => c.name === 'configuration');

    assert.ok(postgres && postgres.status === 'healthy');
    assert.ok(redis && redis.status === 'healthy' && redis.latencyMs === 5);
    assert.ok(configComp && configComp.status === 'healthy');
    console.log('✔ HealthService getReadiness() returns healthy when all dependencies are up');
  }

  // 3. HealthService Readiness - DB down produces unhealthy
  {
    const mockDbService = {
      checkHealth: async () => ({ status: 'down', connected: false, details: 'Connection refused' }),
    } as any;
    const mockRedisService = {
      checkHealth: async () => ({ status: 'up', connected: true, latencyMs: 3 }),
    } as any;

    const healthService = new HealthService(mockDbService, mockRedisService);
    const readiness = await healthService.getReadiness();

    assert.strictEqual(readiness.status, 'unhealthy');
    const postgres = readiness.components!.find((c) => c.name === 'postgresql');
    assert.strictEqual(postgres?.status, 'unhealthy');
    assert.strictEqual(postgres?.details, 'Connection refused');
    console.log('✔ HealthService getReadiness() returns unhealthy when PostgreSQL is down');
  }

  // 4. HealthService Readiness - Redis down produces unhealthy
  {
    const mockDbService = {
      checkHealth: async () => ({ status: 'up', connected: true }),
    } as any;
    const mockRedisService = {
      checkHealth: async () => ({ status: 'down', connected: false, details: 'Redis timeout' }),
    } as any;

    const healthService = new HealthService(mockDbService, mockRedisService);
    const readiness = await healthService.getReadiness();

    assert.strictEqual(readiness.status, 'unhealthy');
    const redis = readiness.components!.find((c) => c.name === 'redis');
    assert.strictEqual(redis?.status, 'unhealthy');
    assert.strictEqual(redis?.details, 'Redis timeout');
    console.log('✔ HealthService getReadiness() returns unhealthy when Redis is down');
  }

  // 5. HealthService Readiness - Exception handling for DB check
  {
    const mockDbService = {
      checkHealth: async () => {
        throw new Error('Unexpected DB error');
      },
    } as any;
    const mockRedisService = {
      checkHealth: async () => ({ status: 'up', connected: true }),
    } as any;

    const healthService = new HealthService(mockDbService, mockRedisService);
    const readiness = await healthService.getReadiness();

    assert.strictEqual(readiness.status, 'unhealthy');
    const postgres = readiness.components!.find((c) => c.name === 'postgresql');
    assert.strictEqual(postgres?.status, 'unhealthy');
    assert.strictEqual(postgres?.details, 'Unexpected DB error');
    console.log('✔ HealthService handles exceptions thrown by dependencies gracefully');
  }

  // 6. HealthController status codes on healthy vs unhealthy
  {
    const mockHealthService = {
      getOverallHealth: async () => ({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptimeSeconds: 10,
        environment: 'test',
        components: [],
      }),
      getLiveness: () => ({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptimeSeconds: 10,
        environment: 'test',
      }),
      getReadiness: async () => ({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        uptimeSeconds: 10,
        environment: 'test',
        components: [{ name: 'redis', status: 'unhealthy', details: 'Timeout' }],
      }),
    } as any;

    const controller = new HealthController(mockHealthService);

    // Live endpoint
    const liveRes = controller.getLiveness();
    assert.strictEqual(liveRes.status, 'healthy');

    // Overall endpoint healthy -> status unchanged (200 default)
    let overallStatusCode = 200;
    const mockRes1: any = {
      status: (code: number) => {
        overallStatusCode = code;
        return mockRes1;
      },
    };
    const overallRes = await controller.getOverallHealth(mockRes1);
    assert.strictEqual(overallRes.status, 'healthy');
    assert.strictEqual(overallStatusCode, 200);

    // Readiness endpoint unhealthy -> sets status 503
    let readyStatusCode = 200;
    const mockRes2: any = {
      status: (code: number) => {
        readyStatusCode = code;
        return mockRes2;
      },
    };
    const readyRes = await controller.getReadiness(mockRes2);
    assert.strictEqual(readyRes.status, 'unhealthy');
    assert.strictEqual(readyStatusCode, HttpStatus.SERVICE_UNAVAILABLE);
    assert.strictEqual(readyStatusCode, 503);

    console.log('✔ HealthController sets 503 Service Unavailable when readiness is unhealthy');
  }

  console.log('\nAll Health Module tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
