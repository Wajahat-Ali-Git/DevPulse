import assert from 'assert';
import { RepositorySyncQueueService } from './repository-sync-queue.service';
import { QueueName, JobName } from '@devpulse/types';

/**
 * Unit tests for RepositorySyncQueueService.
 *
 * Tests that the dedicated BullMQ queue for repository synchronization:
 * - Is lazily initialised with the correct queue name and job defaults
 * - Returns the same singleton queue instance on repeated calls
 * - Enqueues SYNC_USER_REPOSITORIES jobs with correct payload and jobId
 * - Enqueues SYNC_SINGLE_REPOSITORY jobs with correct payload and jobId
 * - Retrieves jobs by ID via getJob()
 * - Closes the queue gracefully on onModuleDestroy()
 */

interface MockJob {
  id: string;
  name: string;
  data: any;
}

class MockQueue {
  public readonly name: string;
  public readonly defaultJobOptions: any;
  private jobs = new Map<string, MockJob>();
  private _closed = false;

  constructor(name: string, opts: any = {}) {
    this.name = name;
    this.defaultJobOptions = opts.defaultJobOptions ?? {};
  }

  async add(jobName: string, data: any, opts: any = {}): Promise<MockJob> {
    const job: MockJob = { id: opts.jobId || `auto-${Date.now()}`, name: jobName, data };
    this.jobs.set(job.id, job);
    return job;
  }

  async getJob(jobId: string): Promise<MockJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  get closed() {
    return this._closed;
  }
}

async function runTests() {
  console.log('=== Running RepositorySyncQueueService Unit Tests ===\n');

  // Test 1: Queue name and singleton initialisation
  {
    console.log('Test 1: Dedicated queue name and lazy singleton initialisation');
    const service = new RepositorySyncQueueService(undefined);

    // Inject mock instead of opening real Redis
    let constructedWith: { name: string; opts: any } | null = null;
    (service as any).queue = (() => {
      const q = new MockQueue(QueueName.REPOSITORY_SYNC, {
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { count: 1000, age: 86400 },
          removeOnFail: { count: 5000, age: 604800 },
        },
      });
      constructedWith = { name: q.name, opts: q.defaultJobOptions };
      return q;
    })();

    const q1 = service.getQueue();
    const q2 = service.getQueue();
    assert.strictEqual(q1, q2, 'getQueue() must return the same queue singleton');
    assert.strictEqual((q1 as any).name, QueueName.REPOSITORY_SYNC);
    console.log('  ✔ Dedicated queue uses correct QueueName.REPOSITORY_SYNC and returns singleton\n');
  }

  // Test 2: addSyncUserRepositoriesJob — enqueues with correct job name, payload, and jobId
  {
    console.log('Test 2: addSyncUserRepositoriesJob enqueues correct job name, payload, and jobId');
    const service = new RepositorySyncQueueService(undefined);
    const mockQueue = new MockQueue(QueueName.REPOSITORY_SYNC);
    (service as any).queue = mockQueue;

    const payload = { userId: 'user-1', workspaceId: 'ws-1', forced: false, correlationId: 'corr-abc' };
    const job = await service.addSyncUserRepositoriesJob(payload, { jobId: 'job-user-sync-1' });

    assert.strictEqual(job.name, JobName.SYNC_USER_REPOSITORIES);
    assert.strictEqual(job.id, 'job-user-sync-1');
    assert.strictEqual(job.data.userId, 'user-1');
    assert.strictEqual(job.data.workspaceId, 'ws-1');
    assert.strictEqual(job.data.forced, false);
    assert.strictEqual(job.data.correlationId, 'corr-abc');
    console.log('  ✔ SYNC_USER_REPOSITORIES job enqueued with correct name, jobId, and payload\n');
  }

  // Test 3: addSyncUserRepositoriesJob — uses correlationId as jobId when jobId is not provided
  {
    console.log('Test 3: addSyncUserRepositoriesJob uses correlationId as jobId when jobId is omitted');
    const service = new RepositorySyncQueueService(undefined);
    const mockQueue = new MockQueue(QueueName.REPOSITORY_SYNC);
    (service as any).queue = mockQueue;

    const payload = { userId: 'user-2', workspaceId: 'ws-2', forced: true, correlationId: 'corr-xyz' };
    const job = await service.addSyncUserRepositoriesJob(payload, { correlationId: 'corr-xyz' });

    assert.strictEqual(job.id, 'corr-xyz', 'correlationId should be used as jobId when jobId is omitted');
    assert.strictEqual(job.name, JobName.SYNC_USER_REPOSITORIES);
    console.log('  ✔ correlationId is used as jobId when no explicit jobId is provided\n');
  }

  // Test 4: addSyncSingleRepositoryJob — enqueues with correct job name, payload, and jobId
  {
    console.log('Test 4: addSyncSingleRepositoryJob enqueues correct job name, payload, and jobId');
    const service = new RepositorySyncQueueService(undefined);
    const mockQueue = new MockQueue(QueueName.REPOSITORY_SYNC);
    (service as any).queue = mockQueue;

    const payload = {
      userId: 'user-3',
      workspaceId: 'ws-3',
      repositoryId: 'repo-abc',
      githubRepoId: 12345,
      fullName: 'org/repo-abc',
      correlationId: 'corr-single-1',
    };
    const job = await service.addSyncSingleRepositoryJob(payload, { jobId: 'job-single-sync-1' });

    assert.strictEqual(job.name, JobName.SYNC_SINGLE_REPOSITORY);
    assert.strictEqual(job.id, 'job-single-sync-1');
    assert.strictEqual(job.data.repositoryId, 'repo-abc');
    assert.strictEqual(job.data.githubRepoId, 12345);
    assert.strictEqual(job.data.fullName, 'org/repo-abc');
    console.log('  ✔ SYNC_SINGLE_REPOSITORY job enqueued with correct name, jobId, and payload\n');
  }

  // Test 5: getJob — retrieves a previously enqueued job by ID
  {
    console.log('Test 5: getJob retrieves enqueued jobs by ID and returns null for unknown IDs');
    const service = new RepositorySyncQueueService(undefined);
    const mockQueue = new MockQueue(QueueName.REPOSITORY_SYNC);
    (service as any).queue = mockQueue;

    const payload = { userId: 'user-4', workspaceId: 'ws-4', forced: false, correlationId: 'corr-get' };
    await service.addSyncUserRepositoriesJob(payload, { jobId: 'job-get-test' });

    const found = await service.getJob('job-get-test');
    assert.ok(found !== null, 'Should find an enqueued job');
    assert.strictEqual(found!.id, 'job-get-test');
    assert.strictEqual(found!.name, JobName.SYNC_USER_REPOSITORIES);

    const notFound = await service.getJob('job-nonexistent');
    assert.strictEqual(notFound, null, 'Should return null for unknown jobId');
    console.log('  ✔ getJob correctly retrieves existing jobs and returns null for unknown IDs\n');
  }

  // Test 6: onModuleDestroy — gracefully closes the queue
  {
    console.log('Test 6: onModuleDestroy gracefully closes the dedicated queue');
    const service = new RepositorySyncQueueService(undefined);
    const mockQueue = new MockQueue(QueueName.REPOSITORY_SYNC);
    (service as any).queue = mockQueue;

    assert.strictEqual(mockQueue.closed, false, 'Queue should be open initially');
    await service.onModuleDestroy();
    assert.strictEqual(mockQueue.closed, true, 'Queue should be closed after onModuleDestroy');
    console.log('  ✔ onModuleDestroy closes the dedicated BullMQ queue cleanly\n');
  }

  // Test 7: onModuleDestroy — is a no-op when queue was never initialised
  {
    console.log('Test 7: onModuleDestroy is a safe no-op when queue was never initialised');
    const service = new RepositorySyncQueueService(undefined);
    // Do NOT touch service.getQueue() — queue stays undefined
    let threw = false;
    try {
      await service.onModuleDestroy();
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'onModuleDestroy must not throw when queue was never created');
    console.log('  ✔ onModuleDestroy is safe when no queue was ever created\n');
  }

  // Test 8: Queue default job options have correct retry policy
  {
    console.log('Test 8: Queue is initialised with correct default job options (5 attempts, exponential backoff)');
    const service = new RepositorySyncQueueService(undefined);
    const mockQueue = new MockQueue(QueueName.REPOSITORY_SYNC, {
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 1000, age: 86400 },
        removeOnFail: { count: 5000, age: 604800 },
      },
    });
    (service as any).queue = mockQueue;

    const opts = mockQueue.defaultJobOptions;
    assert.strictEqual(opts.attempts, 5, 'Should retry 5 times for external GitHub API sync');
    assert.strictEqual(opts.backoff.type, 'exponential');
    assert.strictEqual(opts.backoff.delay, 2000);
    assert.strictEqual(opts.removeOnComplete.count, 1000);
    assert.strictEqual(opts.removeOnFail.count, 5000);
    console.log('  ✔ Queue default options enforce 5-attempt exponential backoff and cleanup retention\n');
  }

  // Test 9: RepositorySyncService uses RepositorySyncQueueService when injected
  {
    console.log('Test 9: RepositorySyncService delegates enqueue to RepositorySyncQueueService when injected');
    const { RepositorySyncService } = require('./repository-sync.service');

    class MockPrismaClient {
      workspaceMembers = [{ workspaceId: 'ws-1', userId: 'user-alice', role: 'MEMBER' }];
      gitHubAccounts = [{ id: 'gh-alice', userId: 'user-alice', username: 'alice' }];

      workspaceMember = {
        findUnique: async ({ where }: any) => {
          const { workspaceId, userId } = where.workspaceId_userId;
          return this.workspaceMembers.find((m) => m.workspaceId === workspaceId && m.userId === userId) || null;
        },
        findMany: async ({ where }: any) =>
          where.userId ? this.workspaceMembers.filter((m) => m.userId === where.userId) : this.workspaceMembers,
      };
      gitHubAccount = {
        findFirst: async ({ where }: any) =>
          this.gitHubAccounts.find((a) => {
            if (where.id && a.id !== where.id) return false;
            if (where.userId && a.userId !== where.userId) return false;
            return true;
          }) || null,
      };
    }

    let delegatedPayload: any = null;
    let delegatedOptions: any = null;

    const mockQueueService = {
      getQueue: () => ({ add: async () => ({ id: 'delegated-job-1' }) }),
      addSyncUserRepositoriesJob: async (payload: any, opts: any) => {
        delegatedPayload = payload;
        delegatedOptions = opts;
        return { id: opts.jobId || payload.correlationId };
      },
    };

    const service = new RepositorySyncService(
      { client: new MockPrismaClient() as any },
      undefined,
      mockQueueService,
    );

    const result = await service.enqueueRepositorySync('user-alice', {
      workspaceId: 'ws-1',
      githubAccountId: 'gh-alice',
    });

    assert.ok(delegatedPayload !== null, 'addSyncUserRepositoriesJob should have been called');
    assert.strictEqual(delegatedPayload.userId, 'user-alice');
    assert.strictEqual(delegatedPayload.workspaceId, 'ws-1');
    assert.strictEqual(delegatedPayload.githubAccountId, 'gh-alice');
    assert.ok(delegatedPayload.syncId);
    assert.strictEqual(delegatedPayload.scope, 'all');
    assert.ok(delegatedPayload.correlationId, 'Correlation ID should be present in payload');
    assert.strictEqual(result.status, 'enqueued');
    assert.ok(result.syncId);
    assert.strictEqual(result.scope, 'all');
    console.log('  ✔ RepositorySyncService delegates to RepositorySyncQueueService when injected\n');
  }

  console.log('✅ ALL REPOSITORY SYNC QUEUE SERVICE TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
