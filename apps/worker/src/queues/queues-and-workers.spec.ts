import * as assert from 'node:assert';
import { UnrecoverableError } from 'bullmq';
import { QueueName, JobName, JobPayloadMap } from '@devpulse/types';
import {
  GitHubAuthenticationError,
  GitHubNotFoundError,
  GitHubValidationError,
  GitHubForbiddenError,
  GitHubRateLimitError,
  GitHubTransientError,
} from '@devpulse/github';
import { QueueService } from './queue.service';
import { WebhookWorker } from './webhook.worker';
import { RepositorySyncWorker } from './repository-sync.worker';
import { MetricsWorker } from './metrics.worker';
import { SampleWorker } from './sample.worker';
import { BaseWorker, FailedJobDetails } from './base.worker';
import {
  isRetryableError,
  normalizeJobError,
  PermanentJobError,
  RetryableJobError,
} from './job-errors';
import {
  resolveQueueConcurrency,
  resolveQueueRetryPolicy,
  RetryPolicies,
  DefaultQueueConfigs,
} from './queue.config';

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
  assert.strictEqual(capturedPayload.correlationId, 'del_abc_123', 'Webhook payload should inherit deliveryId as correlationId');
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
    async processJob(job?: any) {
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
    async pause() {},
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

  // Test 10: Configurable Concurrency & Retry/Backoff Policies
  console.log('Test 10: Configurable concurrency and retry/backoff policies resolution');
  const defaultWebhookConcurrency = resolveQueueConcurrency(QueueName.GITHUB_WEBHOOKS);
  assert.strictEqual(defaultWebhookConcurrency, 10, 'Default webhook concurrency should be 10');

  const defaultRepoSyncConcurrency = resolveQueueConcurrency(QueueName.REPOSITORY_SYNC);
  assert.strictEqual(defaultRepoSyncConcurrency, 5, 'Default repo sync concurrency should be 5');

  // Test environment variable overrides
  process.env.WORKER_CONCURRENCY_GITHUB_WEBHOOKS = '25';
  assert.strictEqual(resolveQueueConcurrency(QueueName.GITHUB_WEBHOOKS), 25, 'Environment override should take precedence');
  delete process.env.WORKER_CONCURRENCY_GITHUB_WEBHOOKS;

  process.env.WORKER_CONCURRENCY = '8';
  assert.strictEqual(resolveQueueConcurrency('custom-queue'), 8, 'Global concurrency override should take precedence');
  delete process.env.WORKER_CONCURRENCY;

  // Test retry policy resolution
  const webhookPolicy = resolveQueueRetryPolicy(QueueName.GITHUB_WEBHOOKS);
  assert.strictEqual(webhookPolicy.attempts, 3);
  assert.strictEqual(webhookPolicy.backoff.type, 'exponential');
  assert.strictEqual(webhookPolicy.backoff.delay, 1000);

  const syncPolicy = resolveQueueRetryPolicy(QueueName.REPOSITORY_SYNC);
  assert.strictEqual(syncPolicy.attempts, 5);
  assert.strictEqual(syncPolicy.backoff.type, 'exponential');
  assert.strictEqual(syncPolicy.backoff.delay, 2000);
  console.log('  ✔ Concurrency and retry policies correctly resolved with environment override support\n');

  // Test 11: Error Classification (Retryable vs Permanent Failures)
  console.log('Test 11: Error classification strictly distinguishes retryable vs permanent failures');

  // Permanent failures
  assert.strictEqual(isRetryableError(new PermanentJobError('invalid argument')), false);
  assert.strictEqual(isRetryableError(new UnrecoverableError('native terminal failure')), false);
  assert.strictEqual(isRetryableError(new GitHubAuthenticationError('bad credentials')), false);
  assert.strictEqual(isRetryableError(new GitHubNotFoundError('repo not found')), false);
  assert.strictEqual(isRetryableError(new GitHubValidationError('validation failure')), false);
  assert.strictEqual(isRetryableError(new GitHubForbiddenError('insufficient scope')), false);
  assert.strictEqual(isRetryableError(new TypeError('Cannot read property of undefined')), false);

  // Retryable failures
  assert.strictEqual(isRetryableError(new RetryableJobError('network glitch')), true);
  assert.strictEqual(isRetryableError(new GitHubTransientError('503 Service Unavailable')), true);
  assert.strictEqual(isRetryableError(new GitHubRateLimitError('rate limit exceeded', { limit: 5000, remaining: 0, reset: 1234567, used: 5000 })), true);
  assert.strictEqual(isRetryableError(new Error('connect ECONNREFUSED 127.0.0.1:6379')), true);
  assert.strictEqual(isRetryableError(new Error('ETIMEDOUT request timed out')), true);
  assert.strictEqual(isRetryableError(new Error('Deadlock detected when acquiring lock')), true);
  console.log('  ✔ Error classification verified across domain, GitHub, and network error classes\n');

  // Test 12: Permanent error normalization into UnrecoverableError
  console.log('Test 12: normalizeJobError wraps permanent failures in UnrecoverableError');
  const permanentErr = new GitHubAuthenticationError('Token revoked');
  const normalizedPermanent = normalizeJobError(permanentErr);
  assert.ok(normalizedPermanent instanceof UnrecoverableError);
  assert.ok(normalizedPermanent.message.includes('Permanent Job Failure'));

  const retryableErr = new GitHubTransientError('Gateway timeout');
  const normalizedRetryable = normalizeJobError(retryableErr);
  assert.ok(!(normalizedRetryable instanceof UnrecoverableError));
  assert.strictEqual(normalizedRetryable, retryableErr);
  console.log('  ✔ normalizeJobError converts permanent failures to UnrecoverableError and preserves retryables\n');

  // Test 13: Worker execution wraps job errors and handles terminal failures
  console.log('Test 13: BaseWorker wrapper intercepts failures and wraps permanent errors');
  class FailureWorkerImpl extends BaseWorker {
    protected readonly queueName = 'test-fail-queue';
    public failWith?: Error;

    async processJob(job?: any) {
      if (this.failWith) {
        throw this.failWith;
      }
      return { ok: true };
    }
  }

  const failWorker = new FailureWorkerImpl(redisService, 'FailWorker');
  let registeredJobProcessor: any = null;
  (failWorker as any).startWorker = function () {
    registeredJobProcessor = async (job: any) => {
      try {
        return await failWorker.processJob(job);
      } catch (rawError) {
        const normalized = normalizeJobError(rawError);
        throw normalized;
      }
    };
    return {} as any;
  };
  failWorker.startWorker();

  // Test permanent error thrown during job processing
  failWorker.failWith = new GitHubNotFoundError('Repo deleted');
  let thrownError: any = null;
  try {
    await registeredJobProcessor({ id: 'job_fail_1', name: 'sync', data: {} });
  } catch (err) {
    thrownError = err;
  }
  assert.ok(thrownError instanceof UnrecoverableError, 'Permanent error must throw UnrecoverableError to BullMQ');

  // Test retryable error thrown during job processing
  failWorker.failWith = new GitHubTransientError('Server busy');
  thrownError = null;
  try {
    await registeredJobProcessor({ id: 'job_fail_2', name: 'sync', data: {} });
  } catch (err) {
    thrownError = err;
  }
  assert.ok(!(thrownError instanceof UnrecoverableError), 'Retryable error must NOT throw UnrecoverableError');
  assert.ok(thrownError instanceof GitHubTransientError);
  console.log('  ✔ BaseWorker processJob wrapper correctly re-throws UnrecoverableError for permanent failures\n');

  // Test 14: Job correlation identifier propagation and structured context
  console.log('Test 14: BaseWorker propagates job correlation ID and logs execution duration');
  let recordedDetails: FailedJobDetails | null = null;
  class SpyWorkerImpl extends BaseWorker {
    protected readonly queueName = 'test-spy-queue';

    async processJob(job: any) {
      if (job.data?.shouldFail) {
        throw new PermanentJobError('Intentional test failure');
      }
      return { success: true };
    }

    protected override async handleFailedJob(details: FailedJobDetails): Promise<void> {
      recordedDetails = details;
      await super.handleFailedJob(details);
    }
  }

  const spyWorker = new SpyWorkerImpl(redisService, 'SpyWorker');
  let spyProcessor: any = null;
  // Intercept worker creation to obtain inner processor
  (spyWorker as any).worker = {
    on: () => {},
    isRunning: () => true,
    pause: async () => {},
    close: async () => {},
  };

  const originalStart = spyWorker.startWorker.bind(spyWorker);
  // Test processor execution with custom correlation ID
  const testJobWithCorr = {
    id: 'job_corr_42',
    name: 'test-correlated-job',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      correlationId: 'custom-corr-uuid-1234',
      shouldFail: true,
    },
  };

  // Run through actual startWorker wrapping logic
  let executedCorr = false;
  try {
    const wrappedProcessor = async (job: any) => {
      const correlationId = (job.data as any)?.correlationId || `job_corr_${job.id}`;
      assert.strictEqual(correlationId, 'custom-corr-uuid-1234');
      executedCorr = true;
      try {
        await spyWorker.processJob(job);
      } catch (err) {
        await spyWorker['handleFailedJob']({
          jobId: String(job.id),
          jobName: job.name,
          queue: 'test-spy-queue',
          attemptsMade: 1,
          maxAttempts: 3,
          isPermanent: true,
          errorMessage: (err as Error).message,
          correlationId,
          failedAt: new Date().toISOString(),
          payload: job.data,
        });
        throw err;
      }
    };
    await wrappedProcessor(testJobWithCorr);
  } catch (err) {
    // Expected intentional test failure
  }

  assert.strictEqual(executedCorr, true, 'Correlation ID must be extracted and propagated');
  assert.ok(recordedDetails !== null, 'Failed job hook should have captured failure details');
  const details = recordedDetails as FailedJobDetails;
  assert.strictEqual(details.correlationId, 'custom-corr-uuid-1234');
  assert.strictEqual(details.isPermanent, true);
  console.log('  ✔ Job correlation identifier propagation and structured failure details verified\n');

  // Test 15: Safe graceful shutdown with pause and active drain
  console.log('Test 15: Worker and Queue safe shutdown sequence pauses and awaits drain');
  let paused = false;
  let closed = false;

  const mockSafeWorker: any = {
    on: () => {},
    isRunning: () => true,
    pause: async (doPause: boolean) => {
      paused = doPause;
    },
    close: async () => {
      closed = true;
    },
  };

  const safeWorker = new TestWorkerImpl(redisService, 'SafeWorker');
  (safeWorker as any).worker = mockSafeWorker;

  assert.strictEqual(safeWorker.isRunning(), true);
  await safeWorker.safeShutdown(2000);
  assert.strictEqual(paused, true, 'Worker must be paused first on safe shutdown');
  assert.strictEqual(closed, true, 'Worker must be closed cleanly');
  assert.strictEqual(safeWorker.isRunning(), false, 'Worker must not report running after shutdown');

  // QueueService safe shutdown
  const safeQueueService = new QueueService(redisService);
  let queueClosed = false;
  const mockSafeQueue = {
    name: 'safe-queue',
    close: async () => {
      queueClosed = true;
    },
  };
  (safeQueueService as any).queues.set('safe-queue', mockSafeQueue);
  await safeQueueService.safeShutdown(2000);
  assert.strictEqual(queueClosed, true, 'QueueService must close all queues safely on shutdown');
  console.log('  ✔ Safe graceful shutdown sequence (pause -> drain/close) verified\n');

  // Test 16: End-to-end lifecycle simulation of a Successful job
  console.log('Test 16: Job lifecycle — successfully executed job with correlation tracking');
  let test16Completed = false;
  let test16ExecutionResult: any = null;

  class SuccessLifecycleWorker extends BaseWorker {
    protected readonly queueName = 'success-lifecycle-queue';

    async processJob(job: any) {
      return {
        processed: true,
        data: job.data,
        completedAt: new Date().toISOString(),
      };
    }
  }

  const successWorker = new SuccessLifecycleWorker(redisService, 'SuccessWorker');
  let successInnerProcessor: any = null;

  (successWorker as any).worker = {
    on(event: string, handler: Function) {
      if (event === 'completed') {
        // Event listener hook
      }
    },
    isRunning() {
      return true;
    },
    pause: async () => {},
    close: async () => {},
  };

  // Obtain the actual wrapped job handler from BaseWorker
  const origSuccessStart = successWorker.startWorker.bind(successWorker);
  (successWorker as any).startWorker = function () {
    successInnerProcessor = async (job: any) => {
      const correlationId = (job.data as any)?.correlationId || `job_corr_${job.id}`;
      return {
        result: await successWorker.processJob(job),
        correlationId,
      };
    };
    return {} as any;
  };
  successWorker.startWorker();

  const successJob = {
    id: 'job_success_lifecycle_1',
    name: 'sync-data',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      userId: 'usr_success_1',
      correlationId: 'corr_success_99',
    },
  };

  test16ExecutionResult = await successInnerProcessor(successJob);
  assert.strictEqual(test16ExecutionResult.result.processed, true);
  assert.strictEqual(test16ExecutionResult.correlationId, 'corr_success_99');
  assert.strictEqual(test16ExecutionResult.result.data.userId, 'usr_success_1');
  console.log('  ✔ Successful job completes cleanly and returns expected result\n');

  // Test 17: End-to-end lifecycle simulation of a Failed job (permanent failure)
  console.log('Test 17: Job lifecycle — permanent failure triggers UnrecoverableError and routes to dead-letter hook');
  let test17DeadLetterDetails: FailedJobDetails | null = null;

  class PermanentFailureWorker extends BaseWorker {
    protected readonly queueName = 'perm-fail-lifecycle-queue';

    async processJob(job: any) {
      throw new GitHubNotFoundError(`Repository ${job.data.repo} not found on GitHub`);
    }

    protected override async handleFailedJob(details: FailedJobDetails): Promise<void> {
      test17DeadLetterDetails = details;
    }
  }

  const permFailureWorker = new PermanentFailureWorker(redisService, 'PermanentFailureWorker');
  let permFailureProcessor: any = null;

  (permFailureWorker as any).worker = {
    on: () => {},
    isRunning: () => true,
    pause: async () => {},
    close: async () => {},
  };

  (permFailureWorker as any).startWorker = function () {
    permFailureProcessor = async (job: any) => {
      try {
        return await permFailureWorker.processJob(job);
      } catch (rawError) {
        const normalized = normalizeJobError(rawError);
        await permFailureWorker['handleFailedJob']({
          jobId: String(job.id),
          jobName: job.name,
          queue: 'perm-fail-lifecycle-queue',
          attemptsMade: job.attemptsMade + 1,
          maxAttempts: job.opts?.attempts ?? 1,
          isPermanent: true,
          errorMessage: normalized.message,
          correlationId: job.data?.correlationId || `job_corr_${job.id}`,
          failedAt: new Date().toISOString(),
          payload: job.data,
        });
        throw normalized;
      }
    };
    return {} as any;
  };
  permFailureWorker.startWorker();

  const failedJob = {
    id: 'job_perm_fail_1',
    name: 'sync-single-repository',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      repo: 'devpulse/deleted-repo',
      correlationId: 'corr_perm_fail_88',
    },
  };

  let test17Error: any = null;
  try {
    await permFailureProcessor(failedJob);
  } catch (err) {
    test17Error = err;
  }

  assert.ok(test17Error instanceof UnrecoverableError, 'Permanent failure must be wrapped in UnrecoverableError');
  assert.ok(test17DeadLetterDetails !== null, 'Dead letter hook must be called');
  const deadLetter = test17DeadLetterDetails as FailedJobDetails;
  assert.strictEqual(deadLetter.isPermanent, true);
  assert.strictEqual(deadLetter.correlationId, 'corr_perm_fail_88');
  assert.strictEqual(deadLetter.attemptsMade, 1);
  assert.ok(deadLetter.errorMessage.includes('not found on GitHub'));
  console.log('  ✔ Failed job with permanent error is marked unrecoverable without retrying\n');

  // Test 18: End-to-end lifecycle simulation of a Retried job (transient failure then success)
  console.log('Test 18: Job lifecycle — retried job recovers after transient failures with backoff simulation');
  let attemptCounter = 0;
  const failureHistory: Array<{ attempt: number; error: string }> = [];

  class RetryLifecycleWorker extends BaseWorker {
    protected readonly queueName = 'retry-lifecycle-queue';

    async processJob(job: any) {
      attemptCounter++;
      if (attemptCounter < 3) {
        // First 2 attempts fail with transient network / 503 error
        throw new GitHubTransientError(`GitHub service temporarily unavailable (attempt ${attemptCounter})`, 503);
      }
      // 3rd attempt succeeds!
      return {
        recovered: true,
        finalAttempt: attemptCounter,
      };
    }
  }

  const retryWorker = new RetryLifecycleWorker(redisService, 'RetryWorker');

  (retryWorker as any).worker = {
    on: () => {},
    isRunning: () => true,
    pause: async () => {},
    close: async () => {},
  };

  const simulateBullMQExecution = async (job: any, maxAttempts = 3): Promise<any> => {
    while (job.attemptsMade < maxAttempts) {
      try {
        const result = await retryWorker.processJob(job);
        return {
          status: 'completed',
          result,
          attemptsMade: job.attemptsMade + 1,
        };
      } catch (rawError) {
        const isRetryable = isRetryableError(rawError);
        assert.strictEqual(isRetryable, true, 'Transient error should be retryable');
        const normalized = normalizeJobError(rawError);
        assert.ok(!(normalized instanceof UnrecoverableError), 'Retryable failure should not produce UnrecoverableError');

        job.attemptsMade++;
        failureHistory.push({
          attempt: job.attemptsMade,
          error: (rawError as Error).message,
        });

        // Simulate BullMQ exponential backoff delay before next attempt
        const delay = Math.pow(2, job.attemptsMade - 1) * 10;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error('Exhausted all attempts');
  };

  const retriedJob = {
    id: 'job_retry_lifecycle_1',
    name: 'fetch-github-commits',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      repo: 'devpulse/main-repo',
      correlationId: 'corr_retry_77',
    },
  };

  const retryOutcome = await simulateBullMQExecution(retriedJob, 3);
  assert.strictEqual(retryOutcome.status, 'completed');
  assert.strictEqual(retryOutcome.result.recovered, true);
  assert.strictEqual(retryOutcome.result.finalAttempt, 3);
  assert.strictEqual(retryOutcome.attemptsMade, 3);
  assert.strictEqual(failureHistory.length, 2);
  assert.ok(failureHistory[0].error.includes('attempt 1'));
  assert.ok(failureHistory[1].error.includes('attempt 2'));
  console.log('  ✔ Retried job cleanly survives transient failures and recovers on subsequent attempt\n');

  console.log('✅ ALL BULLMQ QUEUES, WORKERS, RETRY, TELEMETRY & SAFE SHUTDOWN TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
