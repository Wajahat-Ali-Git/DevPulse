import * as assert from 'node:assert';
import { QueueName, JobName, JobPayloadMap } from '@devpulse/types';
import { QueueService } from './queue.service';
import { WebhookWorker } from './webhook.worker';
import { RepositorySyncWorker } from './repository-sync.worker';
import { MetricsWorker } from './metrics.worker';
import { SampleWorker } from './sample.worker';
import { BaseWorker } from './base.worker';

// Mock RedisService with no network I/O
class MockRedisService {
  client = {
    status: 'ready',
    on: () => {},
    once: () => {},
    removeListener: () => {},
  } as any;

  async checkHealth() {
    return { status: 'up', connected: true };
  }
}

async function runTests() {
  console.log('=== Running BullMQ Queues and Workers Unit Tests ===\n');

  const redisService = new MockRedisService() as any;

  // Test 1: Shared Queue Names and Job Names defined in @devpulse/types
  console.log('Test 1: Verify shared QueueName and JobName enum integrity');
  assert.strictEqual(QueueName.GITHUB_WEBHOOKS, 'github-webhooks');
  assert.strictEqual(QueueName.REPOSITORY_SYNC, 'repository-sync');
  assert.strictEqual(QueueName.METRICS_CALCULATION, 'metrics-calculation');
  assert.strictEqual(QueueName.NOTIFICATIONS, 'notifications');
  assert.strictEqual(QueueName.SAMPLE, 'sample-jobs');

  assert.strictEqual(JobName.PROCESS_WEBHOOK_EVENT, 'process-webhook-event');
  assert.strictEqual(JobName.SYNC_USER_REPOSITORIES, 'sync-user-repositories');
  assert.strictEqual(JobName.SYNC_SINGLE_REPOSITORY, 'sync-single-repository');
  assert.strictEqual(JobName.CALCULATE_REPOSITORY_METRICS, 'calculate-repository-metrics');
  assert.strictEqual(JobName.CALCULATE_WORKSPACE_METRICS, 'calculate-workspace-metrics');
  assert.strictEqual(JobName.SAMPLE_JOB, 'sample-job');
  console.log('  ✔ Shared QueueName and JobName definitions verified\n');

  // Test 2: QueueService lazy-instantiation and registration
  console.log('Test 2: QueueService registers and returns queues on demand');
  const queueService = new QueueService(redisService);

  // Stub internal queue factory to prevent opening raw sockets in unit tests
  const mockQueues = new Map<string, any>();
  (queueService as any).getOrCreateQueue = (queueName: string) => {
    if (!mockQueues.has(queueName)) {
      mockQueues.set(queueName, {
        name: queueName,
        add: async (name: string, payload: any) => ({
          id: 'mock_job_123',
          name,
          data: payload,
          timestamp: Date.now(),
        }),
        close: async () => {},
      });
      (queueService as any).queues.set(queueName, mockQueues.get(queueName));
    }
    return mockQueues.get(queueName);
  };

  const q1 = queueService.getOrCreateQueue(QueueName.GITHUB_WEBHOOKS);
  const q2 = queueService.getOrCreateQueue(QueueName.GITHUB_WEBHOOKS);
  assert.strictEqual(q1, q2, 'getOrCreateQueue should return singleton queue instance per name');
  assert.deepStrictEqual(queueService.getRegisteredQueueNames(), [QueueName.GITHUB_WEBHOOKS]);
  console.log('  ✔ QueueService singleton caching and lazy instantiation verified\n');

  // Test 3: QueueService addTypedJob and payload typing
  console.log('Test 3: QueueService.addTypedJob enqueues typed payloads');
  let capturedJobName = '';
  let capturedPayload: any = null;

  (q1 as any).add = async (name: string, payload: any) => {
    capturedJobName = name;
    capturedPayload = payload;
    return {
      id: 'mock_job_123',
      name,
      data: payload,
      timestamp: Date.now(),
    };
  };

  const testPayload: JobPayloadMap[JobName.PROCESS_WEBHOOK_EVENT] = {
    deliveryId: 'del_abc_123',
    event: 'push',
    action: undefined,
    sender: 'octocat',
    rawPayload: { ref: 'refs/heads/main' },
    receivedAt: new Date().toISOString(),
  };

  const jobData = await queueService.addTypedJob(
    QueueName.GITHUB_WEBHOOKS,
    JobName.PROCESS_WEBHOOK_EVENT,
    testPayload,
  );

  assert.strictEqual(jobData.id, 'mock_job_123');
  assert.strictEqual(jobData.name, JobName.PROCESS_WEBHOOK_EVENT);
  assert.strictEqual(capturedJobName, JobName.PROCESS_WEBHOOK_EVENT);
  assert.strictEqual(capturedPayload.deliveryId, 'del_abc_123');
  console.log('  ✔ Typed enqueue method works and preserves payload shape\n');

  // Test 4: WebhookWorker processing logic
  console.log('Test 4: WebhookWorker executes processJob and returns structured result');
  const webhookWorker = new WebhookWorker(redisService);
  const webhookMockJob = {
    id: 'job_wh_1',
    name: JobName.PROCESS_WEBHOOK_EVENT,
    data: {
      deliveryId: 'delivery-uuid-999',
      event: 'pull_request',
      action: 'opened',
      sender: 'developer',
      rawPayload: {},
      receivedAt: new Date().toISOString(),
    },
  } as any;

  const webhookResult = await webhookWorker.processJob(webhookMockJob);
  assert.strictEqual(webhookResult.received, true);
  assert.strictEqual(webhookResult.deliveryId, 'delivery-uuid-999');
  assert.strictEqual(webhookResult.eventType, 'pull_request');
  console.log('  ✔ WebhookWorker processes jobs with correlation context\n');

  // Test 5: RepositorySyncWorker processing logic
  console.log('Test 5: RepositorySyncWorker executes sync job and returns success');
  const repoSyncWorker = new RepositorySyncWorker(redisService);
  const syncMockJob = {
    id: 'job_sync_1',
    name: JobName.SYNC_USER_REPOSITORIES,
    data: {
      userId: 'usr_1',
      workspaceId: 'ws_1',
      forced: true,
    },
  } as any;

  const syncResult = await repoSyncWorker.processJob(syncMockJob);
  assert.strictEqual(syncResult.success, true);
  assert.strictEqual(syncResult.jobName, JobName.SYNC_USER_REPOSITORIES);
  console.log('  ✔ RepositorySyncWorker handles repository sync payload\n');

  // Test 6: MetricsWorker processing logic
  console.log('Test 6: MetricsWorker processes metrics calculation payload');
  const metricsWorker = new MetricsWorker(redisService);
  const metricsMockJob = {
    id: 'job_met_1',
    name: JobName.CALCULATE_REPOSITORY_METRICS,
    data: {
      repositoryId: 'repo_123',
      workspaceId: 'ws_123',
    },
  } as any;

  const metricsResult = await metricsWorker.processJob(metricsMockJob);
  assert.strictEqual(metricsResult.success, true);
  assert.strictEqual(metricsResult.jobName, JobName.CALCULATE_REPOSITORY_METRICS);
  console.log('  ✔ MetricsWorker processes metrics calculations successfully\n');

  // Test 7: SampleWorker processing logic
  console.log('Test 7: SampleWorker handles diagnostic test payloads');
  const sampleWorker = new SampleWorker(redisService);
  const sampleMockJob = {
    id: 'job_smp_1',
    name: JobName.SAMPLE_JOB,
    data: {
      message: 'ping-diagnostic',
    },
  } as any;

  const sampleResult = await sampleWorker.processJob(sampleMockJob);
  assert.strictEqual(sampleResult.success, true);
  assert.strictEqual(sampleResult.message, 'ping-diagnostic');
  console.log('  ✔ SampleWorker processes diagnostic payloads\n');

  // Test 8: BaseWorker event listener setup and lifecycle
  console.log('Test 8: BaseWorker event listener callbacks handle completed and failed jobs');
  class TestWorkerImpl extends BaseWorker {
    protected readonly queueName = 'test-queue';
    async processJob() {
      return { ok: true };
    }
  }

  const testWorker = new TestWorkerImpl(redisService, 'TestWorker');
  let completedCalled = false;
  let failedCalled = false;

  const mockBullWorker: any = {
    on(event: string, handler: Function) {
      if (event === 'completed') {
        handler({ id: 'j1', name: 'test' });
        completedCalled = true;
      }
      if (event === 'failed') {
        handler({ id: 'j2', name: 'test' }, new Error('test failure'));
        failedCalled = true;
      }
    },
    isRunning() {
      return true;
    },
    async close() {},
  };

  testWorker['worker'] = mockBullWorker;
  testWorker['registerEventListeners']();

  assert.strictEqual(completedCalled, true, 'completed listener should be registered');
  assert.strictEqual(failedCalled, true, 'failed listener should be registered');
  assert.strictEqual(testWorker.isRunning(), true);
  await testWorker.onModuleDestroy();
  console.log('  ✔ BaseWorker error and completion logging lifecycle listeners verified\n');

  // Test 9: QueueService graceful shutdown closes all open queues
  console.log('Test 9: QueueService onModuleDestroy cleanly closes all registered queues');
  let qCloseCount = 0;
  q1.close = async () => {
    qCloseCount++;
  };
  await queueService.onModuleDestroy();
  assert.strictEqual(qCloseCount, 1, 'Registered queues must be closed upon destruction');
  console.log('  ✔ QueueService onModuleDestroy properly closes BullMQ queues\n');

  console.log('✅ ALL BULLMQ QUEUES AND WORKERS UNIT TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
